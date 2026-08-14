// Pure rules for the shopper's order-history tabs.
//
// "In store" is a customer journey, not only a checkout source: a counter
// sale and an online order collected from a shop both require the customer to
// visit the store. Keeping this pure makes the visibility rules easy to test
// without a browser or database.

export interface OrderHistoryChannelView {
  sales_channel?: string | null;
  fulfilment_type?: string | null;
}

export function isInStoreJourney(order: OrderHistoryChannelView): boolean {
  return order.sales_channel === "pos" || order.fulfilment_type === "pickup";
}

export function shouldShowInStoreHistory(input: {
  orders: OrderHistoryChannelView[];
  supportsPos: boolean;
  supportsPickup: boolean;
}): boolean {
  // Historical purchases remain reachable after a merchant disables POS,
  // pickup, a location, or a paid plan. Current feature gates may remove a
  // future journey; they must never hide a receipt the shopper already owns.
  return (
    input.supportsPos ||
    input.supportsPickup ||
    input.orders.some(isInStoreJourney)
  );
}
