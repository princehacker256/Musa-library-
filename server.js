import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import admin from "firebase-admin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const PRICE_UGX = 1000;
const APP_DATA_DOC = "musaSonsMovieLibraryV10";
const MARZPAY_BASE = "https://wallet.wearemarz.com/api/v1";

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
  const key = requiredEnv("MARZPAY_API_KEY");
  const secret = requiredEnv("MARZPAY_API_SECRET");
  const basic = Buffer.from(`${key}:${secret}`).toString("base64");
  return { Authorization: `Basic ${basic}`, "Content-Type": "application/json" };
}

async function marzRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...marzHeaders(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.message || body.error || `MarzPay request failed (${response.status})`;
    throw new Error(message);
  }
  return body;
}

async function requireFirebaseUser(req, res, next) {
  try {
    const header = req.get("authorization") || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ message: "Sign-in required." });
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.user = { uid: decoded.uid, email: decoded.email || null };
    next();
  } catch {
    return res.status(401).json({ message: "Your sign-in session is invalid or expired. Sign in again." });
  }
}

function normalizeUgPhone(value) {
  let phone = String(value || "").replace(/[^\d+]/g, "");
  if (phone.startsWith("0")) phone = "+256" + phone.slice(1);
  if (phone.startsWith("256")) phone = "+" + phone;
  if (!phone.startsWith("+256") || !/^\+256\d{9}$/.test(phone)) {
    throw new Error("Enter a valid Uganda Mobile Money number, e.g. 07XXXXXXXX.");
  }
  return phone;
}

async function getMovie(movieId) {
  const snap = await db.collection("appData").doc(APP_DATA_DOC).get();
  if (!snap.exists) throw new Error("Movie library data was not found.");
  const data = snap.data() || {};
  const movies = Array.isArray(data.movies) ? data.movies : [];
  return movies.find(movie => String(movie.id) === String(movieId)) || null;
}

function extractTransaction(payload) {
  return payload?.data?.transaction || payload?.transaction || payload?.data || payload || {};
}

function extractCollection(payload) {
  return payload?.data?.collection || payload?.collection || {};
}

function transactionIsPaid(payload) {
  const tx = extractTransaction(payload);
  const status = String(tx.status || payload?.status || "").toLowerCase();
  const amount = tx.amount?.raw ?? tx.amount ?? extractCollection(payload)?.amount?.raw;
  const currency = String(tx.amount?.currency || extractCollection(payload)?.amount?.currency || "UGX").toUpperCase();
  return ["completed", "successful", "success", "paid"].includes(status)
    && Number(amount) === PRICE_UGX
    && currency === "UGX";
}

async function verifyAndGrant(orderRef) {
  const orderRefDoc = db.collection("premiumOrders").doc(orderRef);
  const orderSnap = await orderRefDoc.get();
  if (!orderSnap.exists) return { status: "not_found", accessGranted: false };
  const order = orderSnap.data();

  if (order.status === "paid") return { status: "paid", accessGranted: true };
  if (!order.marzUuid) return { status: order.status || "pending", accessGranted: false };

  const verified = await marzRequest(`${MARZPAY_BASE}/collect-money/${encodeURIComponent(order.marzUuid)}`, { method: "GET" });
  const tx = extractTransaction(verified);
  const status = String(tx.status || "").toLowerCase();

  if (transactionIsPaid(verified)) {
    const entitlementId = `${order.uid}_${order.movieId}`;
    const batch = db.batch();
    batch.set(orderRefDoc, {
      status: "paid",
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      marzTransactionStatus: status
    }, { merge: true });
    batch.set(db.collection("premiumEntitlements").doc(entitlementId), {
      uid: order.uid,
      movieId: order.movieId,
      orderReference: orderRef,
      amount: PRICE_UGX,
      currency: "UGX",
      grantedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    await batch.commit();
    return { status: "paid", accessGranted: true };
  }

  if (["failed", "cancelled", "canceled", "expired"].includes(status)) {
    await orderRefDoc.set({ status: status === "canceled" ? "cancelled" : status }, { merge: true });
    return { status: status === "canceled" ? "cancelled" : status, accessGranted: false };
  }

  return { status: "pending", accessGranted: false };
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "musa-sons-premium-payments" }));

app.post("/api/premium/checkout", requireFirebaseUser, async (req, res) => {
  try {
    const movieId = String(req.body?.movieId || "").trim();
    if (!movieId) return res.status(400).json({ message: "Movie ID is required." });

    const movie = await getMovie(movieId);
    if (!movie || movie.isPremium !== true) {
      return res.status(400).json({ message: "This movie is not marked as premium by the administrator." });
    }

    const phone = normalizeUgPhone(req.body?.phone);
    const reference = crypto.randomUUID();
    const orderDoc = db.collection("premiumOrders").doc(reference);

    await orderDoc.set({
      reference,
      uid: req.user.uid,
      movieId,
      movieTitle: String(movie.title || "Premium movie").slice(0, 150),
      phone,
      amount: PRICE_UGX,
      currency: "UGX",
      country: "UG",
      status: "creating",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const createResponse = await marzRequest(`${MARZPAY_BASE}/collect-money`, {
      method: "POST",
      body: JSON.stringify({
        amount: PRICE_UGX,
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

    await orderDoc.set({
      status: "pending",
      marzUuid,
      marzCreateStatus: tx.status || "processing"
    }, { merge: true });

    res.json({ reference, status: "pending" });
  } catch (error) {
    console.error("Premium checkout error:", error);
    res.status(400).json({ message: error.message || "Could not start payment." });
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
    res.json(result);
  } catch (error) {
    console.error("Premium status error:", error);
    res.status(502).json({ message: "Could not verify payment with MarzPay. Please try again." });
  }
});

// MarzPay callbacks are only notifications. The server re-checks the transaction
// directly with MarzPay before granting access; callback content alone is not trusted.
app.post("/api/marzpay/callback", async (req, res) => {
  res.status(200).json({ received: true });
  try {
    const payload = req.body || {};
    const tx = extractTransaction(payload);
    const reference = String(tx.reference || payload.reference || "");
    if (!reference) return;
    const orderSnap = await db.collection("premiumOrders").doc(reference).get();
    if (!orderSnap.exists) return;
    await verifyAndGrant(reference);
  } catch (error) {
    console.error("MarzPay callback verification error:", error);
  }
});

// Serve the existing single-file website from the same Render Web Service.
const publicDir = path.join(__dirname, "public");

app.use(express.static(publicDir, { extensions: ["html"] }));

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => console.log(`Musa & Sons service listening on ${PORT}`));
