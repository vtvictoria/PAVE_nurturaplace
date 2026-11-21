// netlify/functions/deliver.js
//
// Gates PDF-guide delivery behind a real, completed Stripe payment, and makes
// each purchase link usable only once.
//
// Expected URL (set as the Payment Link's "After payment" redirect):
//   https://pave.nurturaplace.com.au/.netlify/functions/deliver?session_id={CHECKOUT_SESSION_ID}&product=vic-foundation
//
//   - {CHECKOUT_SESSION_ID} is a literal placeholder Stripe fills in automatically.
//   - product= is whatever short code you choose per guide (must match a PDF
//     filename in /pdfs, e.g. product=vic-foundation -> pdfs/vic-foundation.pdf).

const fs = require("fs");
const path = require("path");

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2026-11-18.endive";

function html(statusCode, title, message) {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
      <style>body{font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 24px;color:#2a2a2a;line-height:1.6}
      h1{font-size:1.4rem}</style></head>
      <body><h1>${title}</h1><p>${message}</p></body></html>`,
  };
}

exports.handler = async function (event) {
  const params = event.queryStringParameters || {};
  const sessionId = params.session_id;
  const product = params.product;

  if (!sessionId || !product) {
    return html(
      400,
      "Missing information",
      "This link is missing required details. Please contact pave@nurturaplace.com.au with your payment receipt."
    );
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return html(
      500,
      "Setup incomplete",
      "The site isn't fully configured yet (missing STRIPE_SECRET_KEY). Please contact pave@nurturaplace.com.au."
    );
  }

  // 1. Retrieve the Checkout Session from Stripe and confirm it was paid.
  let session;
  try {
    const sessRes = await fetch(
      `${STRIPE_API}/checkout/sessions/${encodeURIComponent(sessionId)}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Stripe-Version": STRIPE_VERSION,
        },
      }
    );
    if (!sessRes.ok) {
      let errBody = "";
      try {
        errBody = await sessRes.text();
      } catch (e) {
        errBody = "(could not read error body)";
      }
      return html(
        400,
        "Could not verify payment",
        "We couldn't verify this payment with Stripe. Please contact pave@nurturaplace.com.au with your payment receipt." +
          `<br><br><small>Debug info (TEMPORARY — remove once working): Stripe responded with status ${sessRes.status}.<br>${errBody}</small>`
      );
    }
    session = await sessRes.json();
  } catch (err) {
    return html(
      500,
      "Something went wrong",
      "Please contact pave@nurturaplace.com.au with your payment receipt."
    );
  }

  if (session.payment_status !== "paid") {
    return html(
      402,
      "Payment not completed",
      "This purchase doesn't show as paid yet. If you believe this is a mistake, contact pave@nurturaplace.com.au."
    );
  }

  // 2. Single-use check: has this exact session already been redeemed?
  if (session.metadata && session.metadata.redeemed === "true") {
    return html(
      403,
      "Link already used",
      "This download link has already been used once. Each purchase link only works a single time. " +
        "If you need your guide re-sent, email pave@nurturaplace.com.au with your payment receipt."
    );
  }

  // 3. Locate the PDF for the purchased product.
  //    Only letters, numbers, hyphens and underscores allowed in the product
  //    code, so this can never be tricked into reading an unexpected file.
  if (!/^[a-zA-Z0-9_-]+$/.test(product)) {
    return html(400, "Invalid request", "Please contact pave@nurturaplace.com.au with your payment receipt.");
  }
  const fileName = `${product}.pdf`;

  const candidatePaths = [
    path.join(__dirname, "..", "..", "pdfs", fileName),
    path.join(process.cwd(), "pdfs", fileName),
    path.join("/var/task", "pdfs", fileName),
  ];

  let fileBuffer = null;
  let triedPaths = [];
  for (const p of candidatePaths) {
    triedPaths.push(p);
    try {
      if (fs.existsSync(p)) {
        fileBuffer = fs.readFileSync(p);
        break;
      }
    } catch (e) {
      // keep trying the next candidate path
    }
  }

  if (!fileBuffer) {
    // Diagnostic info to make this fixable quickly instead of guessing blind.
    let dirListing = "";
    try {
      dirListing = JSON.stringify({
        __dirname,
        cwd: process.cwd(),
        dirnameContents: fs.readdirSync(__dirname),
      });
    } catch (e) {
      dirListing = "could not read directory listing";
    }
    return html(
      500,
      "Guide file not found",
      `We couldn't locate the file for "${product}" on the server yet. ` +
        `<br><br><small>Debug info (send this to your developer): triedPaths=${JSON.stringify(
          triedPaths
        )}<br>${dirListing}</small>`
    );
  }

  // 4. Mark this session as redeemed (best-effort, before serving the file).
  try {
    await fetch(`${STRIPE_API}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Stripe-Version": STRIPE_VERSION,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "metadata[redeemed]=true",
    });
  } catch (err) {
    // If this fails, we still serve the file this one time rather than
    // blocking a paying customer over a logging problem.
  }

  // 5. Serve the PDF.
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
    body: fileBuffer.toString("base64"),
    isBase64Encoded: true,
  };
};
