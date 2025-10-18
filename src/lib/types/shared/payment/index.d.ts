export interface StripeDefinition {
  stripeItems: StripePaymentOption[];
  paymentMethodTypes: ("card" | "amazon_pay" | "paypal")[];
}

export interface StripeDetailedItem {
  priceName: string;
  priceId: string;
  type: "subscription" | "payment";
  price: number;
  currency: string;
  interval?: "month" | "year" | "week" | "day";
  intervalCount?: number;
  description?: string;
  name?: string;
}
