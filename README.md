# MUSA & SONS MOVIE LIBRARY — Render Web Service

This project combines the existing single-file website with a Node.js/Express backend.
The backend creates UGX 1,000 MarzPay Mobile Money collections and verifies the payment
directly with MarzPay before writing an entitlement to Firestore.

## Render settings

For your existing Render **Web Service** connected to GitHub:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Node version: 20 or newer

Commit these project files to the same GitHub repository and deploy the commit.

## Environment variables in Render

Add the following under **Environment** (never commit real secrets to GitHub):

- `MARZPAY_API_KEY` — your real MarzPay API key
- `MARZPAY_API_SECRET` — your real MarzPay API secret
- `FIREBASE_SERVICE_ACCOUNT_JSON` — the complete Firebase Admin service-account JSON on one line

The Firebase service account must belong to the same Firebase project used by the website.
Give the service account access to Firestore. Do not share or publish its private key.

## Important sign-in requirement

The current website has legacy phone/password accounts stored in its app data, while its
Google and email-link sign-in options use Firebase Authentication. This secure backend
requires a genuine Firebase ID token. The updated checkout therefore allows premium
payments only for users signed in through Google or email-link authentication.

Legacy phone/password accounts must be migrated to Firebase Authentication before they
can use secure premium checkout. Do not solve this by sending a browser-supplied user ID
or password to the payment API.

## Firestore records

The backend reads the existing movie list from:
`appData/musaSonsMovieLibraryV10` (field: `movies`).

It writes:
- `premiumOrders/{uuid-reference}`
- `premiumEntitlements/{firebaseUid_movieId}`

The server determines the movie title and premium flag from Firestore. It fixes the
price at UGX 1,000; it does not trust the amount or title sent by the browser.

## Payment flow

1. A signed-in Firebase user chooses a premium movie.
2. The backend creates a unique UUID reference and calls MarzPay `POST /collect-money`.
3. MarzPay sends a callback to `/api/marzpay/callback`.
4. The backend treats the callback only as a notification and independently fetches
   `GET /collect-money/{transaction-uuid}` from MarzPay.
5. Only a verified successful UGX 1,000 collection grants a Firestore entitlement.
6. The website polls `/api/premium/status` while the customer approves the prompt.

## Critical video-protection limitation

This integration secures payment creation and payment verification, but it does NOT by
itself make movie files private. If the movie URLs are readable from the public website
or Firestore, a technically capable visitor may still access those URLs without paying.
For real paywall enforcement, store videos in private object storage and issue short-lived
signed playback URLs from the backend after checking `premiumEntitlements`. Do not treat
the browser's local `premiumMovieAccess` flag as a security boundary.

## Test before going live

Use MarzPay sandbox mode first if your merchant account is in sandbox. Verify:
- checkout rejects unsigned / unauthenticated requests;
- only premium movies can be charged;
- a pending transaction does not unlock a movie;
- an independently verified successful UGX 1,000 transaction creates one entitlement;
- duplicate callbacks do not create duplicate charges or duplicate access grants.

Health check: `/api/health`
