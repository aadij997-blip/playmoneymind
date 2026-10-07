const UNIT_CENTS = 1599;
const LOCATION_ID = "LFPCG9BC6WSPQ";
const SQUARE_VERSION = "2026-09-16";
const PRODUCT_NAME = "InvestQuest Financial Literacy Card Game";
const SHOP_EMAIL = "gamesmoneymind@gmail.com";
const ALLOWED = new Set([
  "https://playmoneymind.com",
  "https://www.playmoneymind.com"
]);

const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

const cors = (origin) => ({
  "Access-Control-Allow-Origin": ALLOWED.has(origin) ? origin : "https://playmoneymind.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
  "Access-Control-Allow-Headers": "Content-Type"
});

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) }
  });

const square = async (env, path, payload, method = "GET") => {
  const response = await fetch(`https://connect.squareup.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "Square-Version": SQUARE_VERSION
    },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
};

const formatAddress = (address = {}) => {
  const line = [
    address.address_line_1,
    address.address_line_2,
    [address.locality, address.administrative_district_level_1, address.postal_code]
      .filter(Boolean)
      .join(", "),
    address.country
  ].filter(Boolean);
  return line.join("\n");
};

const purchaserFromOrder = (order = {}) => {
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  const shipment = fulfillments.find((item) => item.type === "SHIPMENT") || fulfillments[0] || {};
  const recipient =
    shipment.shipment_details?.recipient ||
    shipment.pickup_details?.recipient ||
    {};
  const address = recipient.address || {};
  const name = String(
    recipient.display_name ||
    [address.first_name, address.last_name].filter(Boolean).join(" ") ||
    ""
  ).trim();
  return {
    name: name || "InvestQuest buyer",
    email: String(recipient.email_address || "").trim(),
    phone: String(recipient.phone_number || "").trim(),
    address: formatAddress(address)
  };
};

const lineSummary = (order = {}) => {
  const items = Array.isArray(order.line_items) ? order.line_items : [];
  if (!items.length) return PRODUCT_NAME;
  return items
    .map((item) => `${item.name || PRODUCT_NAME} × ${item.quantity || "1"}`)
    .join("\n");
};

const loadOrderBundle = async (env, orderId, paymentId) => {
  let order = null;
  let payment = null;

  if (orderId) {
    const loaded = await square(env, `/v2/orders/${orderId}`);
    if (loaded.response.ok) order = loaded.body?.order || null;
  }

  if (paymentId) {
    const loaded = await square(env, `/v2/payments/${paymentId}`);
    if (loaded.response.ok) payment = loaded.body?.payment || null;
  }

  if (!order && payment?.order_id) {
    const loaded = await square(env, `/v2/orders/${payment.order_id}`);
    if (loaded.response.ok) order = loaded.body?.order || null;
  }

  if (!payment && order?.tenders?.[0]?.payment_id) {
    const loaded = await square(env, `/v2/payments/${order.tenders[0].payment_id}`);
    if (loaded.response.ok) payment = loaded.body?.payment || null;
  }

  return { order, payment };
};

// Returns purchaser contact from the paid Square order so the site can email
// the shop. Square's own merchant notice often shows the business-profile
// name (e.g. Heather Diamond) and omits buyer contact fields.
const handleNotify = async (env, orderId, paymentId, origin) => {
  if (!orderId && !paymentId) {
    return json({ error: "Missing Square order or payment id." }, 400, origin);
  }

  const { order, payment } = await loadOrderBundle(env, orderId, paymentId);
  if (!order?.id) {
    return json({ error: "Square order was not found." }, 404, origin);
  }

  const buyer = purchaserFromOrder(order);
  const paymentIdResolved = payment?.id || order.tenders?.[0]?.payment_id || paymentId || "";
  return json({
    ok: true,
    shopEmail: SHOP_EMAIL,
    buyer,
    product: lineSummary(order),
    total: money(order.total_money?.amount ?? payment?.total_money?.amount),
    orderId: order.id,
    paymentId: paymentIdResolved
  }, 200, origin);
};

const createCheckoutLink = async (env, qty, origin) => {
  const lineItems = [{
    name: PRODUCT_NAME,
    quantity: String(qty),
    base_price_money: { amount: UNIT_CENTS, currency: "USD" }
  }];
  if (qty >= 2) {
    lineItems.push({
      name: "Shipping",
      quantity: "1",
      note: "Two or more games ship free.",
      base_price_money: { amount: 0, currency: "USD" }
    });
  }

  const created = await square(env, "/v2/online-checkout/payment-links", {
    idempotency_key: crypto.randomUUID(),
    description: `${PRODUCT_NAME} x${qty}`,
    payment_note: "InvestQuest order from playmoneymind.com",
    order: { location_id: LOCATION_ID, line_items: lineItems },
    checkout_options: {
      allow_tipping: false,
      ask_for_shipping_address: true,
      merchant_support_email: SHOP_EMAIL,
      redirect_url: "https://playmoneymind.com/cart.html?paid=1"
    }
  }, "POST");

  const paymentLink = created.body?.payment_link;
  const url = paymentLink?.url;
  if (!created.response.ok || !url) {
    return json({ error: "Square checkout didn’t open. Try again." }, 502, origin);
  }

  // Stamp the Square order id onto the return URL so the thank-you page can
  // load the purchaser from that order instead of the business-profile name.
  if (paymentLink.id && paymentLink.order_id && paymentLink.version != null) {
    await square(env, `/v2/online-checkout/payment-links/${paymentLink.id}`, {
      payment_link: {
        version: paymentLink.version,
        checkout_options: {
          allow_tipping: false,
          ask_for_shipping_address: true,
          merchant_support_email: SHOP_EMAIL,
          redirect_url: `https://playmoneymind.com/cart.html?paid=1&orderId=${encodeURIComponent(paymentLink.order_id)}`
        }
      }
    }, "PUT");
  }

  return json({ url, orderId: paymentLink.order_id || "" }, 200, origin);
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method === "GET") return json({ ok: true }, 200, origin);
    if (request.method !== "POST") return json({ error: "Use POST." }, 405, origin);
    if (!env.SQUARE_ACCESS_TOKEN) {
      return json({ error: "The payment server is missing its Square access token." }, 500, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "The checkout details could not be read." }, 400, origin);
    }

    if (body?.action === "notify") {
      return handleNotify(
        env,
        String(body.orderId || body.order_id || "").trim(),
        String(body.paymentId || body.payment_id || body.transactionId || "").trim(),
        origin
      );
    }

    const qty = Math.floor(Number(body.quantity));
    if (!Number.isInteger(qty) || qty < 1 || qty > 6) {
      return json({ error: "Choose a quantity between 1 and 6." }, 400, origin);
    }

    return createCheckoutLink(env, qty, origin);
  }
};
