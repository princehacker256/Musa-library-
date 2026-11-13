import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import admin from "firebase-admin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const APP_DATA_DOC = "musaSonsMovieLibraryV10";
const MARZPAY_BASE = "https://wallet.wearemarz.com/api/v1";
const MIN_MARZPAY_UGX = 500;
const MAX_MARZPAY_UGX = 10_000_000;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const serviceAccount = JSON.parse(requiredEnv("FIREBASE_SERVICE_ACCOUNT_JSON"));
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

function marzHeaders() {
  const credentials = Buffer.from(`${requiredEnv("MARZPAY_API_KEY")}:${requiredEnv("MARZPAY_API_SECRET")}`).toString("base64");
  return { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" };
}

async function marzRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...marzHeaders(), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || body.error || `MarzPay request failed (${response.status})`);
  }
  return body;
}

async function requireFirebaseUser(req, res, next) {
  try {
    const match = String(req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ message: "Sign in with Google or email link before purchasing." });
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.user = { uid: decoded.uid, email: decoded.email || null };
    return next();
  } catch {
    return res.status(401).json({ message: "Your secure sign-in session is invalid or expired. Sign in again." });
  }
}

function normalizeUgPhone(value) {
  let phone = String(value || "").replace(/[^\d+]/g, "");
  if (phone.startsWith("0")) phone = "+256" + phone.slice(1);
  if (phone.startsWith("256")) phone = "+" + phone;
  if (!/^\+256\d{9}$/.test(phone)) throw new Error("Enter a valid Uganda Mobile Money number, e.g. 07XXXXXXXX.");
  return phone;
}

function entitlementDocId(uid, movieId) {
  return crypto.createHash("sha256").update(`${uid}:${movieId}`).digest("hex");
}

async function getMovie(movieId) {
  const snap = await db.collection("appData").doc(APP_DATA_DOC).get();
  if (!snap.exists) throw new Error("Movie library data was not found.");
  const movies = Array.isArray(snap.data()?.movies) ? snap.data().movies : [];
  return movies.find(movie => String(movie.id) === String(movieId)) || null;
}

function extractTransaction(payload) {
  return payload?.data?.transaction || payload?.transaction || payload?.data || payload || {};
}

function extractCollection(payload) {
  return payload?.data?.collection || payload?.collection || {};
}

function transactionIsPaid(payload, expectedAmount) {
  const tx = extractTransaction(payload);
  const status = String(tx.status || payload?.status || "").toLowerCase();
  const amount = tx.amount?.raw ?? extractCollection(payload)?.amount?.raw ?? tx.amount;
  const currency = String(tx.amount?.currency || extractCollection(payload)?.amount?.currency || "UGX").toUpperCase();
  return ["completed", "successful", "success", "paid"].includes(status)
    && Number(amount) === Number(expectedAmount)
    && currency === "UGX";
}


function signMediaPayload(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", requiredEnv("MEDIA_TOKEN_SECRET")).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyMediaPayload(token) {
  const [encoded, suppliedSignature] = String(token || "").split(".");
  if (!encoded || !suppliedSignature) return null;
  const expected = crypto.createHmac("sha256", requiredEnv("MEDIA_TOKEN_SECRET")).update(encoded).digest();
  let actual;
  try { actual = Buffer.from(suppliedSignature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

async function verifyAndGrant(orderReference) {
  const orderDoc = db.collection("premiumOrders").doc(orderReference);
  const orderSnap = await orderDoc.get();
  if (!orderSnap.exists) return { status: "not_found", accessGranted: false };
  const order = orderSnap.data();
  if (order.status === "paid") return { status: "paid", accessGranted: true };
  if (!order.marzUuid) return { status: order.status || "pending", accessGranted: false };

  // Always verify directly with MarzPay. Never trust browser or callback status alone.
  const verified = await marzRequest(`${MARZPAY_BASE}/collect-money/${encodeURIComponent(order.marzUuid)}`, { method: "GET" });
  const tx = extractTransaction(verified);
  const status = String(tx.status || "").toLowerCase();

  if (transactionIsPaid(verified, order.amount)) {
    const entitlementId = entitlementDocId(order.uid, order.movieId);
    const batch = db.batch();
    batch.set(orderDoc, {
      status: "paid",
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      marzTransactionStatus: status
    }, { merge: true });
    batch.set(db.collection("premiumEntitlements").doc(entitlementId), {
      uid: order.uid,
      movieId: order.movieId,
      orderReference,
      amount: order.amount,
      currency: "UGX",
      grantedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    await batch.commit();
    return { status: "paid", accessGranted: true };
  }

  if (["failed", "cancelled", "canceled", "expired"].includes(status)) {
    const normalized = status === "canceled" ? "cancelled" : status;
    await orderDoc.set({ status: normalized, marzTransactionStatus: status }, { merge: true });
    return { status: normalized, accessGranted: false };
  }
  return { status: "pending", accessGranted: false };
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "musa-sons-premium-payments" }));

app.post("/api/premium/access", requireFirebaseUser, async (req, res) => {
  try {
    const movieId = String(req.body?.movieId || "").trim();
    if (!movieId) return res.status(400).json({ message: "Movie ID is required." });
    const movie = await getMovie(movieId);
    if (!movie) return res.status(404).json({ message: "Movie not found." });
    if (movie.premium !== true) return res.json({ allowed: true, premium: false });
    const entitlementId = entitlementDocId(req.user.uid, movieId);
    const entitlement = await db.collection("premiumEntitlements").doc(entitlementId).get();
    res.set("Cache-Control", "no-store");
    return res.json({ allowed: entitlement.exists, premium: true });
  } catch (error) {
    console.error("Premium access check error:", error);
    return res.status(500).json({ message: "Could not check movie access." });
  }
});

app.post("/api/premium/checkout", requireFirebaseUser, async (req, res) => {
  let orderDoc;
  try {
    const movieId = String(req.body?.movieId || "").trim();
    if (!movieId) return res.status(400).json({ message: "Movie ID is required." });
    const movie = await getMovie(movieId);
    if (!movie || movie.premium !== true) {
      return res.status(400).json({ message: "This movie is not marked as premium by the administrator." });
    }

    const entitlementId = entitlementDocId(req.user.uid, movieId);
    const entitlement = await db.collection("premiumEntitlements").doc(entitlementId).get();
    if (entitlement.exists) return res.json({ alreadyPaid: true, status: "paid", accessGranted: true });

    const amount = Math.floor(Number(movie.premiumPrice) || 1000);
    if (!Number.isSafeInteger(amount) || amount < MIN_MARZPAY_UGX || amount > MAX_MARZPAY_UGX) {
      return res.status(400).json({ message: `The administrator must set this movie's price between UGX ${MIN_MARZPAY_UGX.toLocaleString("en-UG")} and UGX ${MAX_MARZPAY_UGX.toLocaleString("en-UG")}.` });
    }
    const phone = normalizeUgPhone(req.body?.phone);
    const reference = crypto.randomUUID();
    orderDoc = db.collection("premiumOrders").doc(reference);
    await orderDoc.set({
      reference,
      uid: req.user.uid,
      movieId,
      movieTitle: String(movie.title || "Premium movie").slice(0, 150),
      phone,
      amount,
      currency: "UGX",
      country: "UG",
      status: "creating",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const createResponse = await marzRequest(`${MARZPAY_BASE}/collect-money`, {
      method: "POST",
      body: JSON.stringify({
        amount,
        phone_number: phone,
        country: "UG",
        reference,
        description: `Premium movie: ${String(movie.title || "Movie").slice(0, 100)}`,
        callback_url: `${req.protocol}://${req.get("host")}/api/marzpay/callback`,
        metadata: [{ orderId: reference }, { firebaseUid: req.user.uid }]
      })
    });

    const tx = extractTransaction(createResponse);
    const marzUuid = tx.uuid || createResponse?.data?.transaction?.uuid;
    if (!marzUuid) throw new Error("MarzPay did not return a transaction UUID.");
    await orderDoc.set({ status: "pending", marzUuid, marzCreateStatus: tx.status || "processing" }, { merge: true });
    return res.json({ reference, status: "pending", amount, currency: "UGX" });
  } catch (error) {
    if (orderDoc) await orderDoc.set({ status: "failed", errorMessage: String(error.message || "Payment request failed").slice(0, 250) }, { merge: true }).catch(() => {});
    console.error("Premium checkout error:", error);
    return res.status(400).json({ message: error.message || "Could not start payment." });
  }
});

app.post("/api/premium/media-link", requireFirebaseUser, async (req, res) => {
  try {
    const movieId = String(req.body?.movieId || "");
    const vjIndex = Number(req.body?.vjIndex);
    const action = req.body?.action === "download" ? "download" : "watch";
    if (!movieId || !Number.isInteger(vjIndex) || vjIndex < 0) return res.status(400).json({ message: "Invalid movie version." });
    const movie = await getMovie(movieId);
    if (!movie || movie.premium !== true) return res.status(404).json({ message: "Premium movie not found." });
    const entitlement = await db.collection("premiumEntitlements").doc(entitlementDocId(req.user.uid, movieId)).get();
    if (!entitlement.exists) return res.status(403).json({ message: "Payment is required before accessing this movie." });
    const version = Array.isArray(movie.vjLinks) ? movie.vjLinks[vjIndex] : null;
    const mediaUrl = version?.playUrl || version?.url;
    if (!mediaUrl || !/^https:\/\//i.test(mediaUrl) || /\.m3u8(?:[?#]|$)/i.test(mediaUrl)) {
      return res.status(400).json({ message: "This video host cannot be securely streamed through the library. Ask the administrator to use a direct HTTPS MP4/WebM video link." });
    }
    const token = signMediaPayload({ uid: req.user.uid, movieId, vjIndex, action, exp: Math.floor(Date.now() / 1000) + 600 });
    return res.json({ mediaUrl: `/api/premium/media/${encodeURIComponent(movieId)}/${vjIndex}?token=${encodeURIComponent(token)}` });
  } catch (error) {
    console.error("Premium media-link error:", error);
    return res.status(500).json({ message: "Could not prepare protected video." });
  }
});

app.get("/api/premium/media/:movieId/:vjIndex", async (req, res) => {
  try {
    const payload = verifyMediaPayload(req.query.token);
    const movieId = String(req.params.movieId);
    const vjIndex = Number(req.params.vjIndex);
    if (!payload || payload.movieId !== movieId || payload.vjIndex !== vjIndex) return res.status(401).json({ message: "Video access link expired. Reopen the movie and try again." });
    const entitlement = await db.collection("premiumEntitlements").doc(entitlementDocId(payload.uid, movieId)).get();
    if (!entitlement.exists) return res.status(403).json({ message: "Payment is required before accessing this movie." });
    const movie = await getMovie(movieId);
    const version = Array.isArray(movie?.vjLinks) ? movie.vjLinks[vjIndex] : null;
    const mediaUrl = version?.playUrl || version?.url;
    if (!mediaUrl || !/^https:\/\//i.test(mediaUrl) || /\.m3u8(?:[?#]|$)/i.test(mediaUrl)) return res.status(404).json({ message: "Protected video source is unavailable." });
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(mediaUrl, { headers, redirect: "follow" });
    if (!upstream.ok && upstream.status !== 206) return res.status(502).json({ message: "The video host could not provide this video." });
    res.status(upstream.status);
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader("Cache-Control", "private, no-store");
    if (payload.action === "download") res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(String(movie.title || "movie").replace(/[\r\n]/g, "").slice(0, 100))}.mp4`);
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    console.error("Protected media proxy error:", error);
    if (!res.headersSent) res.status(502).json({ message: "Could not stream the protected video." });
    else res.end();
  }
});

app.get("/api/premium/status", requireFirebaseUser, async (req, res) => {
  try {
    const reference = String(req.query.reference || "");
    if (!reference) return res.status(400).json({ message: "Payment reference is required." });
    const snap = await db.collection("premiumOrders").doc(reference).get();
    if (!snap.exists || snap.data().uid !== req.user.uid) {
      return res.status(404).json({ message: "Payment reference was not found for this account." });
    }
    const result = await verifyAndGrant(reference);
    res.set("Cache-Control", "no-store");
    return res.json(result);
  } catch (error) {
    console.error("Premium status error:", error);
    return res.status(502).json({ message: "Could not verify payment with MarzPay. Please try again." });
  }
});

// Callback is a notification only. The server independently verifies with MarzPay.
app.post("/api/marzpay/callback", (req, res) => {
  res.status(200).json({ received: true });
  const payload = req.body || {};
  const tx = extractTransaction(payload);
  const reference = String(tx.reference || payload.reference || "");
  if (!reference) return;
  void verifyAndGrant(reference).catch(error => console.error("MarzPay callback verification error:", error));
});

app.use(express.static(__dirname, { extensions: ["html"] }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(PORT, () => console.log(`Musa & Sons service listening on ${PORT}`));
