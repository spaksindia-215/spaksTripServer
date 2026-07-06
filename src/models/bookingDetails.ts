// Typed per-product booking detail shapes. Booking.productType is the
// discriminator; `details` carries the product-specific payload (often a
// passthrough of the upstream TBO response, so non-core fields stay optional).

export interface FlightBookingDetails {
  origin: string;
  destination: string;
  departDate: string;
  returnDate?: string;
  passengers: number;
  airline?: string;
  flightNumber?: string;
  cabinClass?: string;
}

export interface HotelBookingDetails {
  hotelName: string;
  city: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  hotelCode?: string;
  roomName?: string;
  nights?: number;
}

export interface TaxiBookingDetails {
  pickup: string;
  drop: string;
  pickupDate: string;
  passengers: number;
  vehicleType?: string;
  distanceKm?: number;
}

export interface TourBookingDetails {
  tourName: string;
  startDate: string;
  travellers: number;
  durationDays?: number;
}

export interface CruiseBookingDetails {
  cruiseLine: string;
  departurePort: string;
  startDate: string;
  travellers: number;
  cabinType?: string;
  durationNights?: number;
}

export interface PackageBookingDetails {
  packageName: string;
  startDate: string;
  travellers: number;
  durationDays?: number;
}

// Maps each productType to its detail shape.
export interface BookingDetailMap {
  flight: FlightBookingDetails;
  hotel: HotelBookingDetails;
  taxi: TaxiBookingDetails;
  tour: TourBookingDetails;
  cruise: CruiseBookingDetails;
  package: PackageBookingDetails;
}

// A booking's details are partial — created incrementally / passed through from TBO.
export type AnyBookingDetails = Partial<BookingDetailMap[keyof BookingDetailMap]>;
