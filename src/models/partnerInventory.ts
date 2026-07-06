// Structured, typed shapes for partner inventory — elevated to match the
// incoming standards (client TaxiListing enums/fields and TBO Hotel/Room detail).
// Each PartnerResource carries a `details` object whose shape is determined by
// its `type` (see ResourceDetailMap). Hotel listings mirror the TBO Hotel shape.

export const RESOURCE_TYPES = [
  "hotel",
  "cruise",
  "taxi",
  "taxi_package",
  "tour",
  "tour_package",
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

// ── Shared enums (mirror client/src/types/taxiListing.ts) ──────────────────────
export const TAXI_VEHICLE_TYPES = [
  "Sedan",
  "SUV",
  "Hatchback",
  "MUV",
  "Luxury",
  "Tempo Traveller",
] as const;
export const TAXI_FUEL_TYPES = ["Petrol", "Diesel", "CNG", "Electric", "Hybrid"] as const;
export const TAXI_TRANSMISSION_TYPES = ["Manual", "Automatic"] as const;

export type TaxiVehicleType = (typeof TAXI_VEHICLE_TYPES)[number];
export type TaxiFuelType = (typeof TAXI_FUEL_TYPES)[number];
export type TaxiTransmissionType = (typeof TAXI_TRANSMISSION_TYPES)[number];

// ── Hotel (mirrors TBO Hotel/Room — client/src/lib/mock/hotels.ts) ─────────────
export const HOTEL_PROPERTY_TYPES = ["hotel", "resort", "boutique", "budget", "apartment"] as const;
export const HOTEL_ROOM_TYPES = ["standard", "deluxe", "suite", "villa"] as const;
export const HOTEL_BED_TYPES = ["single", "double", "twin", "king", "queen"] as const;

export type HotelPropertyType = (typeof HOTEL_PROPERTY_TYPES)[number];
export type HotelRoomType = (typeof HOTEL_ROOM_TYPES)[number];
export type HotelBedType = (typeof HOTEL_BED_TYPES)[number];

export interface HotelRoomDetails {
  name: string;
  type: HotelRoomType;
  bedType: HotelBedType;
  maxOccupancy: number;
  basePrice: number;
  refundable: boolean;
  breakfast: boolean;
}

export interface HotelDetails {
  starRating: 1 | 2 | 3 | 4 | 5;
  propertyType: HotelPropertyType;
  city: string;
  country: string;
  address: string;
  latitude?: number;
  longitude?: number;
  checkInTime?: string;
  checkOutTime?: string;
  amenities: string[];
  rooms: HotelRoomDetails[];
}

// ── Taxi & Taxi Package ────────────────────────────────────────────────────────
export interface TaxiDetails {
  vehicleType: TaxiVehicleType;
  brand: string;
  model: string;
  registrationNumber: string;
  seatingCapacity: number;
  fuelType: TaxiFuelType;
  transmission: TaxiTransmissionType;
  acAvailable: boolean;
  luggageCapacity?: number;
  yearOfManufacture?: number;
  operatingCity: string;
  serviceAreas: string[];
  availableRoutes?: string[];
  minimumFare: number;
  pricePerKm: number;
  driverIncluded: boolean;
  selfDriveAvailable: boolean;
  amenities: string[];
}

export interface TaxiPackageDetails {
  vehicleType: TaxiVehicleType;
  seatingCapacity: number;
  operatingCity: string;
  durationDays: number;
  durationNights: number;
  itinerary: string[];
  inclusions: string[];
  exclusions?: string[];
  pricePerPerson?: number;
}

// ── Cruise ─────────────────────────────────────────────────────────────────────
export interface CruiseDetails {
  cruiseLine: string;
  ship: string;
  departurePort: string;
  route: string;
  durationNights: number;
  cabinTypes: string[];
  amenities: string[];
}

// ── Tour & Tour Package ──────────────────────────────────────────────────────────
export interface TourDetails {
  destination: string;
  durationDays?: number;
  durationHours?: number;
  languages: string[];
  maxGroupSize?: number;
  inclusions: string[];
  exclusions?: string[];
}

export interface TourPackageDetails {
  destinations: string[];
  durationDays: number;
  durationNights: number;
  itinerary: string[];
  inclusions: string[];
  exclusions?: string[];
  accommodationLevel?: string;
  transportIncluded?: boolean;
}

// Maps each resource type to its detail shape.
export interface ResourceDetailMap {
  hotel: HotelDetails;
  cruise: CruiseDetails;
  taxi: TaxiDetails;
  taxi_package: TaxiPackageDetails;
  tour: TourDetails;
  tour_package: TourPackageDetails;
}

export type AnyResourceDetails = ResourceDetailMap[ResourceType];
