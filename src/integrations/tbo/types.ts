// Raw TBO API response shapes — no business logic, pure mirrors of TBO JSON.
// Cross-checked against http://apidoc.tektravels.com/flight/Search_jason.aspx and Auth_JSON.aspx

// ─── Shared ──────────────────────────────────────────────────────────────────

export interface TboStatus {
  Code: number;
  Description: string;
}

export interface TboError {
  ErrorCode: number;
  ErrorMessage: string;
}

// ─── Authentication ───────────────────────────────────────────────────────────

export interface TboAuthRequest {
  ClientId: string;
  UserName: string;
  Password: string;
  EndUserIp: string;
}

// IMPORTANT: Per Auth_JSON.aspx, Status is a NUMBER (1=success), not an object
export interface TboAuthResponse {
  Status: number;
  TokenId: string;
  Error: TboError;
  Member: {
    FirstName: string;
    LastName: string;
    Email: string;
    MemberId: number;
    AgencyId: number;
    LoginName: string;
    LoginDetails: string;
    isPrimaryAgent: boolean;
  };
}

// ─── Flights ──────────────────────────────────────────────────────────────────

export interface TboAirlineInfo {
  AirlineCode: string;
  AirlineName: string;
  FlightNumber: string;
  FareClass: string;
  OperatingCarrier: string;
}

export interface TboAirportInfo {
  AirportCode: string;
  AirportName: string;
  Terminal: string;
  CityCode: string;
  CityName: string;
  CountryCode: string;
  CountryName: string;
}

export interface TboSegmentGroup {
  Baggage: string;         // e.g. "20 Kg"
  CabinBaggage: string;    // e.g. "7 Kg"
  CabinClass: number;      // TBO: 2=Economy, 3=PremiumEconomy, 4=Business, 5=PremiumBusiness, 6=First
  SupplierFareClass: string;
  TripIndicator: number;
  SegmentIndicator: number;
  Airline: TboAirlineInfo;
  NoOfSeatAvailable: number;
  Origin: {
    Airport: TboAirportInfo;
    DepTime: string;   // "2025-01-15T06:30:00"
  };
  Destination: {
    Airport: TboAirportInfo;
    ArrTime: string;
  };
  Duration: number;        // minutes
  GroundTime: number;      // layover minutes before next segment
  Mile: number;
  StopOver: boolean;
  StopPoint: string;
  Craft: string;           // aircraft type e.g. "A320neo"
  Remark: string;
  IsETicketEligible: boolean;
  FlightStatus: string;
  Status: string;
}

export interface TboTaxBreakup {
  key: string;
  value: number;
}

// IMPORTANT: TBO returns PublishedFare and OfferedFare. There is NO TotalFare field.
// - PublishedFare = gross airline price
// - OfferedFare = price after agent commission/discount (this is what we charge customer)
export interface TboFare {
  Currency: string;
  BaseFare: number;
  Tax: number;
  TaxBreakup: TboTaxBreakup[];
  YQTax: number;
  AdditionalTxnFeeOfrd: number;
  AdditionalTxnFeePub: number;
  PGCharge: number;
  OtherCharges: number;
  ChargeBU: Array<{
    key: string;
    value: number;
  }>;
  Discount: number;
  PublishedFare: number;
  CommissionEarned: number;
  PLBEarned: number;
  IncentiveEarned: number;
  OfferedFare: number;
  TdsOnCommission: number;
  TdsOnPLB: number;
  TdsOnIncentive: number;
  ServiceFee: number;
}

export interface TboFareBreakdown {
  Currency: string;
  PassengerType: number;   // 1=ADT, 2=CHD, 3=INF
  PassengerCount: number;
  BaseFare: number;
  Tax: number;
  TaxBreakup: TboTaxBreakup[];
  YQTax: number;
  AdditionalTxnFeeOfrd: number;
  AdditionalTxnFeePub: number;
}

export interface TboFareRule {
  Origin: string;
  Destination: string;
  Airline: string;
  FareBasisCode: string;     // TBO field name is FareBasisCode, not FareBasis
  FareRuleDetail: string;    // raw text/HTML from TBO
  FareRestriction: string;
  FareFamilyCode: string;
  FareRuleIndex: string;
}

export interface TboFareFamily {
  FareFamilyCode: string;
  FareFamilyName: string;
  IsRefundable: boolean;
  Baggage: string;
  CabinBaggage: string;
  MealDynamic: string | null;
  SeatDynamic: string | null;
}

export interface TboFlightResult {
  ResultIndex: string;          // opaque key — must be threaded through entire booking flow
  Source: number;
  IsLCC: boolean;
  IsRefundable: boolean;
  IsPanRequiredAtBook: boolean;
  IsPanRequiredAtTicket: boolean;
  IsPassportRequiredAtBook: boolean;
  IsPassportRequiredAtTicket: boolean;
  // When true, full passport detail (No + Expiry + IssueDate + IssueCountryCode)
  // must be passed in Book/Ticket; when false only No + Expiry are required.
  IsPassportFullDetailRequiredAtBook?: boolean;
  // Special fares (Super 6E / SpiceMax): free meal/seat must be selected from the
  // SSR response and included in the Ticket request to avoid failure.
  IsMealMandatory?: boolean;
  IsSeatMandatory?: boolean;
  // Set by FareQuote when itinerary info changed (e.g. "Time", "Baggage") —
  // booking must proceed with the updated info.
  FlightDetailChangeInfo?: string | null;
  GSTINNo: string | null;
  IsGSTMandatory: boolean;
  IsHoldAllowed: boolean;
  IsAlPriceChangeAllowed: boolean;
  TicketAdvisory: string;
  LastTicketDate: string | null;
  AirlineCode: string;
  AirlineName: string;
  Fare: TboFare;
  FareBreakdown: TboFareBreakdown[];
  Segments: TboSegmentGroup[][];  // outer = trip legs, inner = segments per leg
  LastTicketingDate: string | null;
  FareRules: TboFareRule[] | null;
  AirlineRemark: string;
  IsUpsellAvailable: boolean;
  Availability: number;
  FareFamilies: TboFareFamily[] | null;
}

export interface TboFlightSearchResponse {
  Response: {
    ResponseStatus: number;   // 1 = success
    Error: TboError;
    TraceId: string;
    Origin: string;
    Destination: string;
    Results: TboFlightResult[][] | null;  // null when no results
  };
}

// ─── FareQuote ────────────────────────────────────────────────────────────────

export interface TboFareQuoteResponse {
  Response: {
    ResponseStatus: number;
    Error: TboError;
    TraceId: string;
    Results: TboFlightResult | null;
    IsPriceChanged: boolean;
    IsTimeChanged: boolean;
  };
}

// ─── FareRule ─────────────────────────────────────────────────────────────────

export interface TboFareRuleResponse {
  Response: {
    ResponseStatus: number;
    Error: TboError;
    TraceId: string;
    FareRules: TboFareRule[] | null;
  };
}

// ─── SSR ─────────────────────────────────────────────────────────────────────

// LCC — Baggage option returned in Baggage[][] (outer = segment, inner = choices)
export interface TboBaggageSSROption {
  AirlineCode: string;
  FlightNumber: string;
  WayType: number;         // 1=Segment, 2=FullJourney
  Code: string;
  Description: number;     // 1=Included, 2=Direct/Purchase, 3=Imported, 4=Upgrade
  Weight: number;          // kg
  Currency: string;
  Price: number;
  Origin: string;
  Destination: string;
  Text?: string;
}

// LCC — Meal option returned in MealDynamic[][] (outer = segment, inner = choices)
export interface TboMealDynamicOption {
  AirlineCode: string;
  FlightNumber: string;
  WayType: number;
  Code: string;
  Description: number;     // 1=Included, 2=Direct, 3=Imported
  AirlineDescription: string;
  Quantity: number;
  Currency: string;
  Price: number;
  Origin: string;
  Destination: string;
}

// LCC — individual seat in the SeatDynamic map
export interface TboSeatItem {
  AirlineCode: string;
  FlightNumber: string;
  CraftType: string;
  Origin: string;
  Destination: string;
  AvailablityType: number;  // 0=NotSet, 1=Open, 3=Reserved, 4=Blocked, 5=NoSeat
  Description: number;      // 1=Included, 2=Purchase
  Code: string;
  RowNo: string;
  SeatNo: string | null;
  SeatType: number;         // 1=Window, 2=Aisle, 3=Middle
  SeatWayType: number;
  Compartment: number;
  Deck: number;
  Currency: string;
  Price: number;
}

// Non-LCC — meal code + description list
export interface TboMealOption {
  Code: string;
  Description: string;
}

// Non-LCC — seat preference code + description
export interface TboSeatPreferenceOption {
  Code: string;
  Description: string;
}

export interface TboSSRResponse {
  Response: {
    ResponseStatus: number;
    Error: TboError;
    TraceId: string;
    // LCC arrays-of-arrays: outer index = trip segment, inner = available choices
    Baggage?: TboBaggageSSROption[][];
    MealDynamic?: TboMealDynamicOption[][];
    SeatDynamic?: Array<{
      SegmentSeat: Array<{
        RowSeats: Array<{
          Seats: TboSeatItem[];
        }>;
      }>;
    }>;
    SpecialServices?: Array<{
      SegmentSpecialService: Array<{
        SSRService: Array<{
          Origin: string;
          Destination: string;
          Code: string;
          Price: number;
          Currency: string;
        }>;
      }>;
    }>;
    // Non-LCC fields
    Meal?: TboMealOption[];
    SeatPreference?: TboSeatPreferenceOption[];
  };
}

// ─── Book (Flight) ────────────────────────────────────────────────────────────

// LCC Baggage item sent in Passengers[].Baggage[] — mirrors SSR Baggage response shape.
export interface TboLccBaggageItem {
  Code: string;
  Weight: number;
  Price: number;
  Currency: string;
  Origin: string;
  Destination: string;
  AirlineCode: string;
  FlightNumber: string;
  WayType: number;
  Description: number;  // 1=Included, 2=Direct/Purchase
}

// LCC Meal item sent in Passengers[].MealDynamic[] — mirrors SSR MealDynamic response shape.
export interface TboLccMealItem {
  Code: string;
  AirlineDescription: string;
  Price: number;
  Currency: string;
  Origin: string;
  Destination: string;
  AirlineCode: string;
  FlightNumber: string;
  WayType: number;
  Quantity: number;
  Description: number;  // 1=Included, 2=Direct, 3=Imported
}

export interface TboPassengerRequest {
  Title: string;         // FLIGHTS ONLY: "Mr", "Mrs", "Ms", "Mstr", "Miss". HOTELS ONLY: "Mr", "Mrs", "Ms"
  FirstName: string;
  LastName: string;
  PaxType: number;       // 1=ADT, 2=CHD, 3=INF
  DateOfBirth: string;   // "YYYY-MM-DDT00:00:00"
  Gender: number;        // 1=Male, 2=Female
  // On Book (Non-LCC) these are sent as empty strings when absent (matches sample
  // case-01). On LCC Ticket they are omitted entirely when no passport is provided
  // (matches sampleVerificationLogs) — hence optional.
  PassportNo?: string;
  PassportExpiry?: string;
  // Sent only when IsPassportFullDetailRequiredAtBook=true (international GDS/LCC).
  PassportIssueDate?: string;
  PassportIssueCountryCode?: string;
  // PAN & Passport Validation: Adult uses own PAN; Child/Infant pass guardian PAN via GuardianDetails.
  PAN?: string;
  // Required for Child/Infant when PAN/Passport is mandatory and the pax has no own PAN.
  GuardianDetails?: {
    Title: string;
    FirstName: string;
    LastName: string;
    PAN?: string;
  };
  AddressLine1: string;
  City: string;
  CountryCode: string;
  CountryName: string;   // required — e.g. "India"
  Nationality: string;   // ISO-2 country code — TBO field name is Nationality, not NationalityCode
  ContactNo: string;
  Email: string;
  IsLeadPax: boolean;
  // On Book (Non-LCC) these are sent as empty strings (matches sample case-01). On
  // LCC Ticket they are omitted unless GST details are supplied on the lead pax
  // (matches sampleVerificationLogs) — hence optional.
  GSTCompanyAddress?: string;
  GSTCompanyContactNumber?: string;
  GSTCompanyName?: string;
  GSTNumber?: string;
  GSTCompanyEmail?: string;
  Fare: TboFare;
  // LCC SSR: ADT/CHD must send [] minimum; INF must omit entirely (§6/§7).
  Baggage?: TboLccBaggageItem[];
  MealDynamic?: TboLccMealItem[];
  SeatDynamic?: TboLccBaggageItem[];  // same shape accepted by TBO for seat dynamic
  // Non-LCC SSR: passed as a single object (not array).
  Meal?: { Code: string; Description: string };
  Seat?: { Code: string; Description: string };
}

export interface TboPassengerResponse {
  PaxId: number;
  Title: string;
  FirstName: string;
  LastName: string;
  PaxType: number;
  DateOfBirth: string;
  Gender: number;
  PassportNo: string;
  Ticket: {
    TicketId: string;
    TicketNumber: string;
    IssueDate: string;
    ValidatingAirline: string;
    Fare: TboFare;
    Status: string;
  } | null;
}

export interface TboFlightItinerary {
  BookingId: number;
  PNR: string;
  IsPriceChanged: boolean;
  IsTimeChanged: boolean;
  // GetBookingDetails reports the itinerary-level booking status under "Status"
  // (5 = ticketed/confirmed). The Book/Ticket responses use "BookingStatus".
  Status?: number;
  BookingStatus?: number;
  Passenger: TboPassengerResponse[];
  Segments: TboSegmentGroup[][];
  Fare: TboFare;
}

export interface TboFlightBookResponse {
  Response: {
    ResponseStatus: number;
    Error: TboError;
    TraceId: string;
    // TBO Book/Ticket nest the booking result one level deeper, under an inner
    // "Response" (Response.Response.FlightItinerary). FlightItinerary may also be
    // present at this outer level on some sources, so both are optional.
    FlightItinerary?: TboFlightItinerary | null;
    Response?: {
      BookingId?: number;
      PNR?: string;
      FlightItinerary?: TboFlightItinerary | null;
    };
  };
}

// ─── Ticket ───────────────────────────────────────────────────────────────────

interface TboTicketItinerary {
  BookingId: number;
  PNR: string;
  BookingStatus: number;
  // Ticket response may signal a late price change — re-call Ticket with
  // IsPriceChangedAccepted=true once the user accepts the new fare.
  IsPriceChanged?: boolean;
  IsTimeChanged?: boolean;
  Passenger: TboPassengerResponse[];
}

export interface TboTicketResponse {
  Response: {
    ResponseStatus: number;
    Error: TboError;
    TraceId: string;
    // TBO nests the ticket result under an inner "Response"
    // (Response.Response.FlightItinerary). Some sources also surface it at this
    // outer level, so both are optional and the parser checks the nested one first.
    FlightItinerary?: TboTicketItinerary | null;
    Response?: {
      BookingId?: number;
      PNR?: string;
      FlightItinerary?: TboTicketItinerary | null;
    };
  };
}

// ─── GetBookingDetail (Flight) ────────────────────────────────────────────────

export interface TboFlightBookingDetailResponse {
  Response: {
    ResponseStatus: number;
    Error: TboError;
    TraceId: string;
    FlightItinerary: TboFlightItinerary | null;
  };
}

// ─── Hotels ───────────────────────────────────────────────────────────────────

export interface TboHotelPrice {
  CurrencyCode: string;
  RoomPrice: number;
  Tax: number;
  ExtraGuestCharge: number;
  ChildCharge: number;
  OtherCharges: number;
  Discount: number;
  PublishedPrice: number;
  PublishedPriceRoundedOff: number;
  OfferedPrice: number;
  OfferedPriceRoundedOff: number;
  AgentCommission: number;
  AgentMarkUp: number;
}

export interface TboRoomPrice {
  CurrencyCode: string;
  RoomPrice: number;
  Tax: number;
  TotalPrice: number;
  OfferedPrice: number;
  OfferedPriceRoundedOff: number;
}

export interface TboRoomDetail {
  RoomTypeCode: string;
  RoomTypeName: string;
  RatePlanCode: string;
  RatePlanName: string;
  RatePlan: number;
  Price: TboRoomPrice;
  IsRefundable: boolean;
  WithBreakfast: boolean;
  LastCancellationDate: string;
  CancellationPolicies: Array<{ Charge: number; ChargeType: number; FromDate: string; ToDate: string }>;
  Supplements: string[];
  InfoSource: string;
  Inclusion: string[];
}

export interface TboHotelResult {
  HotelCode: string;    // KEY for detail/book chaining
  HotelName: string;
  HotelRating: number;  // 1–5
  HotelAddress: string;
  Attractions: string;
  HotelDescription: string;
  Price: TboHotelPrice;
  RoomDetails: TboRoomDetail[];
  Images: string[];
  Amenities: string[];
  StarRating: number;
  CityId: string;
  HotelLocation: string;
  HotelContactNo: string;
  HotelMap: string;
  HotelPolicy: string;
  HotelFacilities: string[];
}

export interface TboHotelSearchResponse {
  GetHotelResultResponse: {
    ResponseStatus: number;
    Error: TboError;
    TraceId: string;
    Status: string;
    HotelResults: TboHotelResult[] | null;
  };
}

// ─── Hotel Detail ─────────────────────────────────────────────────────────────

export interface TboHotelDetailResponse {
  GetHotelDetailsResponse: {
    ResponseStatus: number;
    Error: TboError;
    TraceId: string;
    HotelDetails: TboHotelResult | null;
  };
}

// ─── Hotel Book ───────────────────────────────────────────────────────────────

export interface TboHotelBookingDetail {
  BookingId: string;
  BookingStatus: string;
  ConfirmationNumber: string;
  HotelName: string;
  CheckIn: string;
  CheckOut: string;
}

export interface TboHotelBookResponse {
  BookResult: {
    ResponseStatus: number;
    Error: TboError;
    TraceId: string;
    HotelBookingDetail: TboHotelBookingDetail | null;
  };
}

// ─── Hotel GetBookingDetail ───────────────────────────────────────────────────

export interface TboHotelBookingDetailResponse {
  GetBookingDetailResult: {
    ResponseStatus: number;
    Error: TboError;
    TraceId: string;
    HotelBookingDetail: TboHotelBookingDetail | null;
  };
}

// ─── TBOHolidays Static Hoteldetails ──────────────────────────────────────────
// Endpoint: POST {TBO_HOLIDAYS_HOTEL_API_URL}/Hoteldetails (Basic Auth)

export interface TboStaticHotelDetail {
  HotelCode: string;
  HotelName: string;
  Description?: string;
  HotelFacilities?: string[];
  // Per docs Attractions can be an object map of "1)" → "...html blob..."
  // or sometimes a plain string. Keep loose.
  Attractions?: Record<string, string> | string;
  Images?: string[];
  Address?: string;
  PinCode?: string;
  CityId?: string;
  CountryName?: string;
  PhoneNumber?: string;
  FaxNumber?: string;
  Map?: string; // "lat|long"
  HotelRating?: number;
  CityName?: string;
  CountryCode?: string;
  CheckInTime?: string;
  CheckOutTime?: string;
  RoomID?: string[];
}

export interface TboStaticHotelDetailsResponse {
  Status?: { Code: number; Description: string };
  HotelDetails?: TboStaticHotelDetail[];
  Error?: TboError;
}

// ─── TBOHolidays TBOHotelCodeList ─────────────────────────────────────────────

// HotelRating is a string enum from TBO ("OneStar".."FiveStar", "All").
export type TboHotelRatingEnum =
  | "OneStar"
  | "TwoStar"
  | "ThreeStar"
  | "FourStar"
  | "FiveStar"
  | "All"
  | (string & {});

export interface TboHotelCodeListItem {
  HotelCode: string;
  HotelName: string;
  HotelRating?: TboHotelRatingEnum;
  Latitude?: string;
  Longitude?: string;
  Address?: string;
  Attractions?: string;
  CityCode?: string;
  CityName?: string;
  CountryName?: string;
  CountryCode?: string;
  Description?: string;
  FaxNumber?: string;
  HotelFacilities?: string;
  Images?: string[];
}

export interface TboHotelCodeListResponse {
  Status?: { Code: number; Description: string };
  Hotels?: TboHotelCodeListItem[];
  Error?: TboError;
}
