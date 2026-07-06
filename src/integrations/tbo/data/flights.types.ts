// Flight domain types shared by the TBO flight adapters.
// Ported verbatim from the Next.js app (client/src/lib/mock/flights.ts) so the
// adapter code moves over unchanged. Only the type declarations the adapters
// depend on are kept here — the mock data generator stays in the frontend.

export type CabinClass = "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";

export type FareFamily = {
  id: string;
  name: string; // e.g. "Saver", "Flex", "Business Lite"
  baggageCabin: number; // kg
  baggageCheckin: number; // kg
  refundable: boolean;
  changeable: boolean;
  mealIncluded: boolean;
  seatSelection: "free" | "paid" | "none";
  priceDelta: number; // added to base price
};

export type FlightSegment = {
  id: string;
  airlineCode: string;
  flightNumber: string;
  aircraft: string;
  from: string; // IATA
  to: string; // IATA
  depart: string; // ISO
  arrive: string; // ISO
  durationMin: number;
  fromTerminal?: string;
  toTerminal?: string;
};

export type FlightOffer = {
  id: string;
  segments: FlightSegment[]; // 1 = direct; 2+ = with stops
  stops: number;
  totalDurationMin: number;
  basePrice: number;
  currency: "INR";
  cabin: CabinClass;
  seatsLeft: number;
  fareFamilies: FareFamily[];
  refundable: boolean;
  baggage: { cabin: number; checkin: number };
  /** Present for domestic return: the inbound leg's TBO ResultIndex.
   *  When set, booking must call Book/Ticket for OB then IB separately (dual-PNR). */
  returnResultIndex?: string;
  /** Inbound leg segments — populated alongside returnResultIndex. */
  returnSegments?: FlightSegment[];
  /** Named tax/fee line items from TBO Fare.TaxBreakup + OtherCharges + ServiceFee. */
  taxBreakdown?: { key: string; amount: number }[];
  /** TBO TraceId from the Search response that created this offer. */
  traceId?: string;
};

export type FlightSearchInput = {
  from: string;
  to: string;
  date: string; // YYYY-MM-DD
  cabin: CabinClass;
  adults: number;
  children: number;
  infants: number;
  directOnly?: boolean;
};
