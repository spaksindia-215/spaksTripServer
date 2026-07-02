import { TboValidationError } from "../errors";
import { getAirport } from "../data/airports";
import type { BookingPassenger } from "./book";
import type { SSRResult } from "./ssr";

// ─────────────────────────────────────────────────────────────────────────────
// Server-side certification validators (CLAUDE.md "Flight Validation").
// These run before a Book/Ticket request is sent to TBO so invalid input is
// surfaced to the user (422) instead of failing at the supplier.
// ─────────────────────────────────────────────────────────────────────────────

// Airline-code groupings.
const AIRASIA_CODES = new Set(["I5", "AK", "FD", "D7", "QZ", "Z2", "XJ"]);
const NO_SPACE_LASTNAME_CODES = new Set(["2T", "ZO"]); // TruJet, Zoom Air
const SPICEJET = "SG";
const INDIGO = "6E";
const FLYDUBAI = "FZ";

// Destination airports that force passport for SpiceJet (Dubai/Riyadh/Sharjah).
const SPICEJET_PASSPORT_AIRPORTS = new Set(["DXB", "RUH", "SHJ"]);
const NEPAL_CC = "NP";

// Valid titles per pax type — TBO support (Jun 2026) requires these for ALL airlines:
//   Male: MR | Female: MRS/MS | Child: MR/MS | Infant: MSTR (only).
const VALID_TITLES: Record<"MALE" | "FEMALE" | "CHILD" | "INFANT", Set<string>> = {
  MALE: new Set(["MR"]),
  FEMALE: new Set(["MRS", "MS"]),
  CHILD: new Set(["MR", "MS"]),
  INFANT: new Set(["MSTR"]),
};

const NAME_FORBIDDEN = /[.,/]/; // special characters disallowed by Navitaire

export interface BookingValidationContext {
  /** "book" for Non-LCC Book step, "ticket" for LCC/Non-LCC Ticket step. */
  stage: "book" | "ticket";
  isLCC: boolean;
  airlineCode: string;
  /** First segment origin / final destination IATA codes (for intl passport rules). */
  origin: string;
  destination: string;
  contactPhone?: string;
  // FareQuote requirement flags.
  isPanRequiredAtBook?: boolean;
  isPanRequiredAtTicket?: boolean;
  isPassportRequiredAtBook?: boolean;
  isPassportRequiredAtTicket?: boolean;
  isPassportFullDetailRequiredAtBook?: boolean;
}

function countryOf(iata: string): string | null {
  return getAirport(iata)?.countryCode ?? null;
}

function ageFromDob(dob?: string): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

/**
 * Which passenger types must carry a passport, given airline + route.
 * Returns a set of pax types ("ADT" | "CHD" | "INF"); empty = none forced by route.
 * (FareQuote's IsPassportRequired flags are additionally honored in the per-pax loop.)
 */
function passportRequiredPaxTypes(ctx: BookingValidationContext): Set<BookingPassenger["type"]> {
  const required = new Set<BookingPassenger["type"]>();
  const destCc = countryOf(ctx.destination);
  const origCc = countryOf(ctx.origin);
  const isIntl = destCc && origCc && destCc !== origCc;
  const code = ctx.airlineCode?.toUpperCase();

  // FlyDubai — passport mandatory for all pax types.
  if (code === FLYDUBAI) {
    required.add("ADT"); required.add("CHD"); required.add("INF");
    return required;
  }

  // SpiceJet to Dubai / Riyadh / Sharjah — passport for all pax types.
  if (code === SPICEJET && SPICEJET_PASSPORT_AIRPORTS.has(ctx.destination?.toUpperCase())) {
    required.add("ADT"); required.add("CHD"); required.add("INF");
    return required;
  }

  // SpiceJet / IndiGo (LCC) to Nepal — passport for Adult + Child.
  if ((code === SPICEJET || code === INDIGO) && destCc === NEPAL_CC) {
    required.add("ADT"); required.add("CHD");
    return required;
  }

  // GDS (Non-LCC) international — passport for Adult + Child, except Nepal.
  if (!ctx.isLCC && isIntl && destCc !== NEPAL_CC) {
    required.add("ADT"); required.add("CHD");
  }

  return required;
}

/**
 * Validates the passenger list for a Book/Ticket request. Collects every problem
 * and throws a single TboValidationError so the user can fix all at once.
 */
export function validateBookingPassengers(
  passengers: BookingPassenger[],
  ctx: BookingValidationContext,
): void {
  const errs: string[] = [];

  if (!passengers.length) errs.push("At least one passenger is required.");

  // Passenger-count limits (server-side, independent of the client form):
  //   • TBO allows at most 9 passengers per booking.
  //   • Every booking needs at least one adult.
  //   • Infants cannot outnumber adults (one lap-infant per adult).
  const MAX_PAX = 9;
  if (passengers.length > MAX_PAX) {
    errs.push(`A maximum of ${MAX_PAX} passengers is allowed per booking.`);
  }
  const adultCount = passengers.filter((p) => p.type === "ADT").length;
  const infantCount = passengers.filter((p) => p.type === "INF").length;
  if (passengers.length > 0 && adultCount < 1) {
    errs.push("At least one adult passenger is required.");
  }
  if (infantCount > adultCount) {
    errs.push("The number of infants cannot exceed the number of adults.");
  }

  // Phone is mandatory for all journeys (LCC & Non-LCC).
  if (!ctx.contactPhone || ctx.contactPhone.replace(/\D/g, "").length < 10) {
    errs.push("A valid contact phone number is required for all journeys.");
  }

  const panRequired = ctx.stage === "book" ? ctx.isPanRequiredAtBook : ctx.isPanRequiredAtTicket;
  const passportFlag = ctx.stage === "book" ? ctx.isPassportRequiredAtBook : ctx.isPassportRequiredAtTicket;
  const routePassportTypes = passportRequiredPaxTypes(ctx);
  const code = ctx.airlineCode?.toUpperCase();

  passengers.forEach((p, i) => {
    const who = `Passenger ${i + 1} (${p.type})`;

    // Title / name presence.
    if (!p.title?.trim()) errs.push(`${who}: title is required.`);
    if (!p.firstName?.trim()) errs.push(`${who}: first name is required.`);
    if (!p.lastName?.trim()) errs.push(`${who}: last name is required.`);

    // No special characters (. , /) in names — Navitaire.
    if (NAME_FORBIDDEN.test(p.firstName ?? "") || NAME_FORBIDDEN.test(p.lastName ?? "")) {
      errs.push(`${who}: name must not contain the characters . , or /`);
    }

    // SpiceJet — first and last name must be distinct.
    if (code === SPICEJET && p.firstName?.trim().toUpperCase() === p.lastName?.trim().toUpperCase()) {
      errs.push(`${who}: SpiceJet requires the first and last name to be different.`);
    }

    // TruJet / Zoom Air — no space allowed in last name.
    if (NO_SPACE_LASTNAME_CODES.has(code) && /\s/.test(p.lastName ?? "")) {
      errs.push(`${who}: this airline does not allow spaces in the last name.`);
    }

    // Title must be valid for the pax type / gender — TBO requires this for ALL
    // airlines (Male MR; Female MRS/MS; Child MR/MS; Infant MSTR).
    if (p.title) {
      const t = p.title.trim().toUpperCase();
      const bucket =
        p.type === "INF" ? "INFANT" :
        p.type === "CHD" ? "CHILD" :
        p.gender === "F" ? "FEMALE" : "MALE";
      if (!VALID_TITLES[bucket].has(t)) {
        errs.push(`${who}: title "${p.title}" is not valid for this passenger type.`);
      }
    }

    // Gender mandatory.
    if (p.gender !== "M" && p.gender !== "F") errs.push(`${who}: gender is required.`);

    // DOB mandatory for Child & Infant; AirAsia also requires DOB for Adult.
    if ((p.type === "CHD" || p.type === "INF") && !p.dob) {
      errs.push(`${who}: date of birth is required for children and infants.`);
    }
    if (AIRASIA_CODES.has(code) && p.type === "ADT" && !p.dob) {
      errs.push(`${who}: AirAsia requires date of birth for adult passengers.`);
    }

    // DOB sanity + age bracket (when a DOB is provided): must be a real, past
    // date, and the age must match the passenger type (infant <2, child 2–11,
    // adult 12+). Catches typos and mismatched pax types that TBO would reject.
    if (p.dob) {
      const dobDate = new Date(p.dob);
      if (Number.isNaN(dobDate.getTime())) {
        errs.push(`${who}: date of birth is not a valid date.`);
      } else if (dobDate.getTime() > Date.now()) {
        errs.push(`${who}: date of birth cannot be in the future.`);
      } else {
        const age = ageFromDob(p.dob);
        if (age !== null) {
          if (p.type === "INF" && age >= 2) {
            errs.push(`${who}: an infant must be under 2 years old.`);
          } else if (p.type === "CHD" && (age < 2 || age >= 12)) {
            errs.push(`${who}: a child must be between 2 and 11 years old.`);
          } else if (p.type === "ADT" && age < 12) {
            errs.push(`${who}: an adult must be 12 years or older.`);
          }
        }
      }
    }

    // PAN & guardian rules.
    if (panRequired) {
      if (p.type === "ADT") {
        // Adult (incl. 12–18) must pass own PAN; guardian PAN is not considered.
        if (!p.pan?.trim()) {
          errs.push(`${who}: PAN is required for this fare. For adults, the passenger's own PAN must be provided.`);
        }
      } else {
        // Child / Infant — guardian's PAN + name (as on PAN) required.
        const g = p.guardian;
        if (!g?.pan?.trim() || !g?.firstName?.trim() || !g?.lastName?.trim()) {
          errs.push(`${who}: a parent/guardian's name and PAN are required for children/infants on this fare.`);
        }
      }
    }

    // Passport: required by FareQuote flag OR by airline+route matrix for this pax type.
    const passportNeeded = Boolean(passportFlag) || routePassportTypes.has(p.type);
    if (passportNeeded) {
      if (!p.passport?.trim()) errs.push(`${who}: passport number is required for this booking.`);
      if (!p.passportExpiry) errs.push(`${who}: passport expiry date is required.`);
      if (ctx.isPassportFullDetailRequiredAtBook) {
        if (!p.passportIssueDate) errs.push(`${who}: passport issue date is required.`);
        if (!p.passportIssueCountryCode?.trim()) errs.push(`${who}: passport issuing country is required.`);
      }
    }

    // LCC first passenger: Address & Email mandatory; AirAsia also needs country.
    if (ctx.isLCC && i === 0) {
      if (!p.addressLine1?.trim() || p.addressLine1.trim().toUpperCase() === "N/A") {
        errs.push(`${who}: address is required for the lead passenger on LCC flights.`);
      }
      if (!p.email?.trim()) {
        errs.push(`${who}: email is required for the lead passenger on LCC flights.`);
      }
      if (AIRASIA_CODES.has(code)) {
        if (!p.countryCode?.trim()) errs.push(`${who}: country code is required for AirAsia.`);
        if (!p.countryName?.trim()) errs.push(`${who}: country name is required for AirAsia.`);
      }
    }
  });

  // No two passengers may share an identical full name — TBO rejects duplicate
  // names on a single booking.
  const nameCounts = new Map<string, number>();
  for (const p of passengers) {
    const key = `${(p.firstName ?? "").trim().toUpperCase()} ${(p.lastName ?? "").trim().toUpperCase()}`.trim();
    if (key) nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  if ([...nameCounts.values()].some((n) => n > 1)) {
    errs.push("Each passenger must have a distinct name — two passengers cannot have exactly the same name.");
  }

  // INF must travel with an ADT.
  const adults = passengers.filter((p) => p.type === "ADT").length;
  const infants = passengers.filter((p) => p.type === "INF").length;
  if (infants > adults) errs.push("Each infant must be accompanied by an adult.");

  if (errs.length) throw new TboValidationError(errs.join(" "));
}

// re-export for callers that compute age (e.g. 12–18 special handling in UI/tests).
export { ageFromDob };

// ─────────────────────────────────────────────────────────────────────────────
// SSR auto-include — Special Fare & free-baggage rules (CLAUDE.md "SSR Validation").
// For special fares (Super 6E / SpiceMax) isseatmandatory/ismealmandatory require a
// FREE (Price 0) meal/seat from SSR in the Ticket request. For all international LCC
// (and I5 domestic) the free baggage (Price 0) must also be included to avail it.
// ─────────────────────────────────────────────────────────────────────────────

export interface MandatorySSRContext {
  isMealMandatory?: boolean;
  isSeatMandatory?: boolean;
  /** Include free (Price 0) baggage from SSR — required for international LCC & I5 domestic. */
  includeFreeBaggage?: boolean;
  /** Include free (Price 0) meal from SSR — required for I5 domestic (CLAUDE.md). */
  includeFreeMeal?: boolean;
}

function isFree(price: number): boolean {
  return !price || price === 0;
}

/**
 * Fills missing mandatory/free SSR selections for ADT/CHD passengers from the SSR
 * response. Infants are skipped (no SSR). Only fills when the passenger has not
 * already chosen — never overrides a user selection, so it cannot regress an
 * already-valid request. Returns a new passenger array.
 */
export function applyMandatorySSR(
  passengers: BookingPassenger[],
  ssr: SSRResult,
  ctx: MandatorySSRContext,
): BookingPassenger[] {
  const wantMeal = Boolean(ctx.isMealMandatory) || Boolean(ctx.includeFreeMeal);
  const wantSeat = Boolean(ctx.isSeatMandatory);
  const wantBag = Boolean(ctx.includeFreeBaggage);
  if (!wantMeal && !wantSeat && !wantBag) return passengers;

  // One free pick per segment.
  const freeBaggagePerSeg = ssr.baggage.map((seg) =>
    seg.find((b) => isFree(b.price) && b.weight > 0),
  );
  const freeMealPerSeg = ssr.mealDynamic.map((seg) =>
    seg.find((m) => isFree(m.price) && m.code && m.code !== "NoMeal"),
  );
  const freeSeatPerSeg = ssr.seatMap.map((seg) =>
    seg.find((s) => isFree(s.price) && s.availabilityType === 1),
  );

  return passengers.map((p) => {
    if (p.type === "INF") return p; // infants carry no SSR
    const next: BookingPassenger = { ...p };

    if (wantBag && (!next.baggageSSR || next.baggageSSR.length === 0)) {
      const picks = freeBaggagePerSeg.filter(Boolean).map((b) => ({
        code: b!.code, weight: b!.weight, price: b!.price, currency: b!.currency,
        origin: b!.origin, destination: b!.destination,
        airlineCode: b!.airlineCode, flightNumber: b!.flightNumber, wayType: b!.wayType,
      }));
      if (picks.length) next.baggageSSR = picks;
    }

    if (wantMeal && (!next.mealSSR || next.mealSSR.length === 0)) {
      const picks = freeMealPerSeg.filter(Boolean).map((m) => ({
        code: m!.code, description: m!.description, price: m!.price, currency: m!.currency,
        origin: m!.origin, destination: m!.destination,
        airlineCode: m!.airlineCode, flightNumber: m!.flightNumber,
      }));
      if (picks.length) next.mealSSR = picks;
    }

    if (wantSeat && (!next.seatSSR || next.seatSSR.length === 0)) {
      const picks = freeSeatPerSeg.filter(Boolean).map((s) => ({
        code: s!.code, price: s!.price, currency: s!.currency,
        origin: s!.origin, destination: s!.destination,
        airlineCode: "", flightNumber: "", wayType: 1,
      }));
      if (picks.length) next.seatSSR = picks;
    }

    return next;
  });
}
