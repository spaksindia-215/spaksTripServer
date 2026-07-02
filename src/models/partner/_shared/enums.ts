// Shared enums for the typed partner-resource models (Hotel | Taxi | TaxiPackage
// | Tour | TourPackage | Cruise). Defined once here so individual schemas never
// hardcode their allowed values. Seeded for HotelListing; extend as the other
// five models land. Mirrors the const-array + derived-union pattern used by
// ../../partnerInventory.ts.

// "pending" = submitted by the partner and awaiting admin approval; "active" is
// only reachable via admin approval, never set directly by a partner.
export const RESOURCE_STATUS = ["draft", "pending", "active", "paused", "suspended"] as const;
export type ResourceStatus = (typeof RESOURCE_STATUS)[number];

export const CURRENCY_CODES = ["INR", "USD", "EUR", "AED", "GBP"] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

// ── Hotel ────────────────────────────────────────────────────────────────────
// Canonical category values. The client form sends human-readable labels
// ("Hotel", "Guest House", …); the controller normalizes to these snake values.
export const HOTEL_TYPES = [
  "hotel",
  "resort",
  "villa",
  "homestay",
  "apartment",
  "guest_house",
  "airbnb",
  "houseboat",
  "hostel",
] as const;
export type HotelType = (typeof HOTEL_TYPES)[number];

// Meal plan + discount values are kept exactly as the form submits them, so no
// normalization round-trip is needed.
export const HOTEL_MEAL_TYPES = [
  "Room Only",
  "Breakfast Included",
  "Half Board",
  "Full Board",
] as const;
export type HotelMealType = (typeof HOTEL_MEAL_TYPES)[number];

export const HOTEL_DISCOUNT_TYPES = ["Percentage", "Fixed Amount"] as const;
export type HotelDiscountType = (typeof HOTEL_DISCOUNT_TYPES)[number];

// The form's star-rating selector allows half-stars.
export const HOTEL_STAR_RATINGS = [1, 2, 3, 3.5, 4, 4.5, 5] as const;
export type HotelStarRating = (typeof HOTEL_STAR_RATINGS)[number];

// ── Taxi (MTI-style, mytaxiindia.com) ─────────────────────────────────────────
// Canonical snake values. The client list-your-taxi form sends labels ("SUV",
// "Tempo Traveller", "Hybrid"); the validator normalizes to these.
export const TAXI_VEHICLE_TYPES = [
  "sedan",
  "suv",
  "muv",
  "hatchback",
  "tempo_traveller",
  "luxury",
] as const;
export type TaxiVehicleType = (typeof TAXI_VEHICLE_TYPES)[number];

// CLAUDE.md spec lists petrol/diesel/cng/electric; `hybrid` added because the
// platform's taxi form offers it (avoid dropping submitted data).
export const TAXI_FUEL_TYPES = ["petrol", "diesel", "cng", "electric", "hybrid"] as const;
export type TaxiFuelType = (typeof TAXI_FUEL_TYPES)[number];

export const TAXI_TRANSMISSION_TYPES = ["manual", "automatic"] as const;
export type TaxiTransmissionType = (typeof TAXI_TRANSMISSION_TYPES)[number];

export const TAXI_LUGGAGE_SIZES = ["small", "medium", "large"] as const;
export type TaxiLuggageSize = (typeof TAXI_LUGGAGE_SIZES)[number];

// MTI service catalogue: each vehicle can offer one or more of these.
export const TAXI_SERVICE_TYPES = [
  "one_way",
  "round_trip",
  "airport_transfer",
  "local_hourly",
  "outstation",
] as const;
export type TaxiServiceType = (typeof TAXI_SERVICE_TYPES)[number];

// ── Tour ─────────────────────────────────────────────────────────────────────
export const TOUR_CATEGORIES = [
  "sightseeing",
  "adventure",
  "cultural",
  "religious",
  "wildlife",
  "cruise_day",
  "honeymoon",
  "group",
] as const;
export type TourCategory = (typeof TOUR_CATEGORIES)[number];

// Short weekday codes used for operating-day selection (tours + future models).
export const OPERATING_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type OperatingDay = (typeof OPERATING_DAYS)[number];

// ── Tour Package ─────────────────────────────────────────────────────────────
export const PACKAGE_TYPES = [
  "fit",
  "group",
  "honeymoon",
  "family",
  "corporate",
  "pilgrimage",
] as const;
export type PackageType = (typeof PACKAGE_TYPES)[number];

export const DEPARTURE_STATUS = ["open", "filling_fast", "closed", "cancelled"] as const;
export type DepartureStatus = (typeof DEPARTURE_STATUS)[number];

export const DIFFICULTY_LEVELS = ["easy", "moderate", "challenging"] as const;
export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number];

// ── Cruise ───────────────────────────────────────────────────────────────────
export const CRUISE_TYPES = ["river", "sea", "backwater", "luxury", "budget"] as const;
export type CruiseType = (typeof CRUISE_TYPES)[number];

export const CABIN_TYPES = ["interior", "ocean_view", "balcony", "suite"] as const;
export type CabinType = (typeof CABIN_TYPES)[number];

export const CRUISE_DEPARTURE_STATUS = ["open", "filling_fast", "closed"] as const;
export type CruiseDepartureStatus = (typeof CRUISE_DEPARTURE_STATUS)[number];

// ── Event ────────────────────────────────────────────────────────────────────
// Events get their own richer lifecycle than the shared RESOURCE_STATUS
// (draft|active|paused|suspended): a listing is submitted for review, published,
// rejected, archived (soft-delete) or cancelled. Kept separate so the existing
// partner resources are untouched.
export const EVENT_STATUS = [
  "draft",
  "pending_review",
  "published",
  "rejected",
  "archived",
  "cancelled",
] as const;
export type EventStatus = (typeof EVENT_STATUS)[number];

export const EVENT_CATEGORIES = [
  "wedding",
  "corporate",
  "birthday_party",
  "engagement",
  "cocktail_party",
  "concert",
  "music_festival",
  "comedy_show",
  "theatre",
  "sports",
  "exhibition",
  "conference",
  "workshop",
  "cultural_festival",
  "religious",
  "charity",
  "networking",
  "food_festival",
  "nightlife",
  "other",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const EVENT_TYPES = ["in_person", "virtual", "hybrid"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const RECURRING_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

export const VIRTUAL_PLATFORMS = ["zoom", "google_meet", "teams", "custom"] as const;
export type VirtualPlatform = (typeof VIRTUAL_PLATFORMS)[number];

export const EVENT_VENUE_TYPES = ["indoor", "outdoor", "both"] as const;
export type EventVenueType = (typeof EVENT_VENUE_TYPES)[number];

export const EVENT_CANCELLATION_POLICIES = [
  "no_refund",
  "full_refund",
  "partial_refund",
  "custom",
] as const;
export type EventCancellationPolicy = (typeof EVENT_CANCELLATION_POLICIES)[number];

// ── Event booking ────────────────────────────────────────────────────────────
export const EVENT_BOOKING_STATUS = [
  "pending",
  "confirmed",
  "cancelled",
  "checked_in",
  "no_show",
] as const;
export type EventBookingStatus = (typeof EVENT_BOOKING_STATUS)[number];

export const EVENT_PAYMENT_STATUS = [
  "pending",
  "initiated",
  "paid",
  "failed",
  "refunded",
  "partially_refunded",
] as const;
export type EventPaymentStatus = (typeof EVENT_PAYMENT_STATUS)[number];

export const EVENT_REFUND_STATUS = [
  "not_applicable",
  "pending",
  "processed",
  "failed",
] as const;
export type EventRefundStatus = (typeof EVENT_REFUND_STATUS)[number];

export const EVENT_BOOKING_SOURCE = ["web", "agent_portal", "api"] as const;
export type EventBookingSource = (typeof EVENT_BOOKING_SOURCE)[number];

// ── Marketplace packages (Package + PackageOffer + PackageEnquiry) ─────────────
// A shared package catalog where the definition (the package) is decoupled from
// pricing (per-operator offers). One package can carry many operator offers; a
// customer enquiry is a lead routed to the chosen operator + the platform.

// Vertical the package belongs to. "holiday" is split national/international via
// PACKAGE_SCOPE; the taxi/tour variants mirror the existing partner models. The
// service verticals (cruise/sightseeing/transfer/self_drive/islandhopper/visa)
// also flow through the unified Package template + PackageOffer marketplace.
export const PACKAGE_KINDS = [
  "taxi",
  "taxi_package",
  "tour",
  "tour_package",
  "holiday",
  "cruise",
  "sightseeing",
  "transfer",
  "self_drive",
  "islandhopper",
  "visa",
  // A composite bundle combining several of a partner's own services (stay +
  // transfer + sightseeing + …) into one sellable, single-priced package. Its
  // pieces live in Package.components; see LISTING_REF_MODELS.
  "bundle",
] as const;
export type PackageKind = (typeof PACKAGE_KINDS)[number];

// Mongoose model names a bundle component may link to — a partner's real listing
// in that vertical. Free-form ("custom") components carry no ref/refModel.
export const LISTING_REF_MODELS = [
  "TaxiListing",
  "TourListing",
  "HotelListing",
  "SightseeingListing",
  "TransferListing",
  "SelfDriveListing",
  "IslandhopperListing",
  "VisaListing",
  "CruiseListing",
  "EventListing",
] as const;
export type ListingRefModel = (typeof LISTING_REF_MODELS)[number];

// Geographic scope — drives the national vs international holiday/tour surfaces.
export const PACKAGE_SCOPES = ["domestic", "international"] as const;
export type PackageScope = (typeof PACKAGE_SCOPES)[number];

// Who authored the package definition: a platform-curated fixed template (admin)
// or a partner's own custom package. Operators attach offers to either.
export const PACKAGE_ORIGINS = ["platform", "partner"] as const;
export type PackageOrigin = (typeof PACKAGE_ORIGINS)[number];

// Lead lifecycle for a customer enquiry against an operator's offer.
export const ENQUIRY_STATUS = [
  "new",
  "contacted",
  "quoted",
  "converted",
  "closed",
  "spam",
] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUS)[number];

// Placeholder payment state — enquiries are lead-only today; this leaves room to
// attach an online payment later without a schema migration.
export const ENQUIRY_PAYMENT_STATUS = [
  "not_applicable",
  "pending",
  "paid",
  "refunded",
] as const;
export type EnquiryPaymentStatus = (typeof ENQUIRY_PAYMENT_STATUS)[number];

// Verticals that route leads through the generic ServiceEnquiry model. Mirrors
// the new partner-service modules (SightSeeing first; the rest land later).
export const SERVICE_VERTICALS = [
  "sightseeing",
  "transfer",
  "self_drive",
  "islandhopper",
  "visa",
] as const;
export type ServiceVertical = (typeof SERVICE_VERTICALS)[number];

// ── SightSeeing ──────────────────────────────────────────────────────────────
// Tours, activities, attractions and experiences listed by a partner. Mirrors the
// Tour vertical; pricing follows a model (per-person / per-group / tiered).
export const SIGHTSEEING_CATEGORIES = [
  "tour",
  "water_activity",
  "adventure",
  "cultural",
  "nature",
  "nightlife",
  "family",
  "attraction",
  "other",
] as const;
export type SightseeingCategory = (typeof SIGHTSEEING_CATEGORIES)[number];

export const SIGHTSEEING_DIFFICULTY = ["easy", "moderate", "challenging"] as const;
export type SightseeingDifficulty = (typeof SIGHTSEEING_DIFFICULTY)[number];

export const SIGHTSEEING_PRICING_MODELS = ["per_person", "per_group", "tiered"] as const;
export type SightseeingPricingModel = (typeof SIGHTSEEING_PRICING_MODELS)[number];

export const SIGHTSEEING_DURATION_UNITS = ["hours", "half_day", "full_day"] as const;
export type SightseeingDurationUnit = (typeof SIGHTSEEING_DURATION_UNITS)[number];

// Cancellation policy shared by the new service modules (matches the spec's
// dropdown). "custom" leaves room for free-text terms in termsAndConditions.
export const SERVICE_CANCELLATION_POLICIES = [
  "free_24h",
  "free_48h",
  "free_72h",
  "non_refundable",
  "custom",
] as const;
export type ServiceCancellationPolicy = (typeof SERVICE_CANCELLATION_POLICIES)[number];

// ── Transfer ─────────────────────────────────────────────────────────────────
// Point-to-point airport / inter-city transfer services.
export const TRANSFER_TYPES = [
  "airport_pickup",
  "airport_dropoff",
  "round_trip",
  "intercity",
  "harbour",
] as const;
export type TransferType = (typeof TRANSFER_TYPES)[number];

export const TRANSFER_VEHICLE_TYPES = [
  "sedan",
  "suv",
  "van",
  "minibus",
  "bus",
  "speedboat",
] as const;
export type TransferVehicleType = (typeof TRANSFER_VEHICLE_TYPES)[number];

// ── Self-Drive ───────────────────────────────────────────────────────────────
// Car / scooter / vehicle rental for self-drive exploration.
export const SELF_DRIVE_CATEGORIES = [
  "economy",
  "compact",
  "suv",
  "luxury",
  "scooter_bike",
  "electric",
] as const;
export type SelfDriveCategory = (typeof SELF_DRIVE_CATEGORIES)[number];

export const TRANSMISSION_TYPES = ["automatic", "manual"] as const;
export type TransmissionType = (typeof TRANSMISSION_TYPES)[number];

export const FUEL_TYPES = ["petrol", "diesel", "electric", "hybrid"] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export const MILEAGE_POLICIES = ["unlimited", "limited"] as const;
export type MileagePolicy = (typeof MILEAGE_POLICIES)[number];

export const FUEL_POLICIES = ["full_to_full", "same_to_same", "pre_purchase"] as const;
export type FuelPolicyType = (typeof FUEL_POLICIES)[number];

export const INSURANCE_TIERS = ["basic", "standard", "premium"] as const;
export type InsuranceTier = (typeof INSURANCE_TIERS)[number];

// ── Islandhopper ─────────────────────────────────────────────────────────────
// Inter-island travel: domestic flight / seaplane / speedboat / ferry / yacht.
export const ISLANDHOPPER_SERVICE_TYPES = [
  "domestic_flight",
  "seaplane",
  "speedboat",
  "ferry",
  "yacht_charter",
] as const;
export type IslandhopperServiceType = (typeof ISLANDHOPPER_SERVICE_TYPES)[number];

// ── Visa Consultancy ─────────────────────────────────────────────────────────
// Consultancy/service model connecting users with visa experts.
export const VISA_CATEGORIES = ["pr", "work", "study", "visit"] as const;
export type VisaCategory = (typeof VISA_CATEGORIES)[number];

export const VISA_CONSULTATION_MODES = ["in_person", "video", "phone", "email"] as const;
export type VisaConsultationMode = (typeof VISA_CONSULTATION_MODES)[number];

export const VISA_PAYMENT_STRUCTURES = ["full_upfront", "phased", "pay_after_approval"] as const;
export type VisaPaymentStructure = (typeof VISA_PAYMENT_STRUCTURES)[number];
