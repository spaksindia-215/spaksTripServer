// Seeds ONE demo partner and one AUTO-APPROVED (status "active") listing of every
// listing type in the Listing-Flow architecture, so the full browse → detail →
// enquiry flow can be exercised end-to-end without waiting on admin approval.
//
// Run from server/:  npm run seed:demo
// (needs MONGO_URI in .env and Node >= 20.9)
//
// Idempotent: wipes this partner's existing demo listings on each run, then
// recreates them. Bypasses the registration/listing validators — DEV/TEST only.

import bcrypt from "bcrypt";
import mongoose from "mongoose";
import { connectDb } from "../src/config/db";
import { UserModel } from "../src/models/User";
import { HotelListingModel } from "../src/models/partner/HotelListing";
import { TaxiListingModel } from "../src/models/partner/TaxiListing";
import { TaxiPackageModel } from "../src/models/partner/TaxiPackage";
import { TourListingModel } from "../src/models/partner/TourListing";
import { TourPackageModel } from "../src/models/partner/TourPackage";
import { CruiseListingModel } from "../src/models/partner/CruiseListing";
import { SightseeingListingModel } from "../src/models/partner/SightseeingListing";
import { TransferListingModel } from "../src/models/partner/TransferListing";
import { SelfDriveListingModel } from "../src/models/partner/SelfDriveListing";
import { IslandhopperListingModel } from "../src/models/partner/IslandhopperListing";
import { VisaListingModel } from "../src/models/partner/VisaListing";
import { PackageModel } from "../src/models/partner/Package";
import { PackageOfferModel } from "../src/models/partner/PackageOffer";

const EMAIL = "homeopathy38@gmail.com";
const PASSWORD = "Test@1234";
const PHONE = "9000000009";
const BCRYPT_ROUNDS = 12;

const IMG = [{ url: "/forest.jpg", isPrimary: true }];
const daysFromNow = (n: number): Date => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

// Stable demo photos (picsum keeps a URL→image mapping by seed) so the detail
// page's carousel + gallery show real variety without bundling assets.
const gallery = (seed: string): { url: string; isPrimary?: boolean }[] =>
  [1, 2, 3, 4].map((n) => ({ url: `https://picsum.photos/seed/${seed}${n}/1000/620`, isPrimary: n === 1 }));

// Build a simple day-by-day itinerary for an N-day package.
const buildItinerary = (days: number, place: string): {
  day: number; title: string; description: string; meals: { breakfast: boolean; lunch: boolean; dinner: boolean }; accommodation?: string; activities: string[];
}[] =>
  Array.from({ length: Math.max(1, days) }, (_, idx) => {
    const day = idx + 1;
    const first = day === 1;
    const last = day === Math.max(1, days);
    return {
      day,
      title: first ? `Arrival in ${place}` : last ? "Departure" : `Explore ${place}`,
      description: first
        ? `Arrive in ${place}, meet our representative and transfer to your hotel. Evening free to relax or explore nearby markets.`
        : last
          ? `After breakfast, check out and transfer to the airport/port for your onward journey with beautiful memories.`
          : `Full day of sightseeing and activities around ${place}, including popular attractions and leisure time.`,
      meals: { breakfast: !first, lunch: false, dinner: !last },
      accommodation: last ? undefined : `Hotel in ${place}`,
      activities: first ? ["Airport pickup", "Hotel check-in"] : last ? ["Checkout", "Airport drop"] : ["Guided sightseeing", "Local experiences"],
    };
  });

async function ensurePartner(): Promise<mongoose.Types.ObjectId> {
  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS);
  const existing = await UserModel.findOne({ email: EMAIL });
  if (existing) {
    existing.set({
      name: existing.name || "Demo Partner",
      passwordHash,
      role: "partner",
      status: "active",
      emailVerified: true,
      aadhar: existing.aadhar || "123412341234",
      failedLoginAttempts: 0,
      lockUntil: null,
    });
    if (!existing.branding?.companyName) {
      existing.branding = { ...(existing.branding ?? {}), companyName: "Andaman Demo Travels", primaryColor: existing.branding?.primaryColor ?? "#185FA5" } as typeof existing.branding;
    }
    await existing.save();
    return existing._id as mongoose.Types.ObjectId;
  }
  const created = await UserModel.create({
    name: "Demo Partner",
    phone: PHONE,
    email: EMAIL,
    passwordHash,
    role: "partner",
    status: "active",
    emailVerified: true,
    aadhar: "123412341234",
    gst: "35DEMOP1234P1Z5",
    pan: "DEMOP1234P",
    creditLimit: null,
    walletBalance: 0,
    branding: { companyName: "Andaman Demo Travels", primaryColor: "#185FA5" },
  });
  return created._id as mongoose.Types.ObjectId;
}

async function wipe(partner: mongoose.Types.ObjectId): Promise<void> {
  await Promise.all([
    HotelListingModel.deleteMany({ partner }),
    TaxiListingModel.deleteMany({ partner }),
    TaxiPackageModel.deleteMany({ partner }),
    TourListingModel.deleteMany({ partner }),
    TourPackageModel.deleteMany({ partner }),
    CruiseListingModel.deleteMany({ partner }),
    SightseeingListingModel.deleteMany({ partner }),
    TransferListingModel.deleteMany({ partner }),
    SelfDriveListingModel.deleteMany({ partner }),
    IslandhopperListingModel.deleteMany({ partner }),
    VisaListingModel.deleteMany({ partner }),
    PackageModel.deleteMany({ author: partner }),
    PackageOfferModel.deleteMany({ partner }),
  ]);
}

async function seedTypedListings(partner: mongoose.Types.ObjectId): Promise<void> {
  await HotelListingModel.create({
    partner, status: "active", name: "Demo Sea View Resort", type: "hotel", starRating: 4,
    description: "Beachfront demo resort in Port Blair with sea-facing rooms.",
    address: { city: "Port Blair", state: "Andaman & Nicobar", country: "India" },
    contact: { phone: "9000000009", email: EMAIL },
    amenities: ["WiFi", "Pool", "Breakfast", "Sea View"],
    pricing: { basePricePerNight: 4500, taxPercentage: 12, currency: "INR" },
    images: IMG, tags: ["demo"],
  });

  await TaxiListingModel.create({
    partner, status: "active",
    vehicle: { make: "Toyota", model: "Innova Crysta", type: "suv", fuelType: "diesel", transmission: "manual", seatingCap: 7, acAvailable: true, luggageSpace: "large", images: IMG },
    services: [{ type: "outstation", isActive: true, pricing: { baseFare: 2500, pricePerKm: 14, driverAllowance: 400, taxPercent: 5 }, coverage: { baseCity: "Port Blair", servicedCities: ["Havelock", "Neil Island"] } }],
    driver: { name: "Demo Driver", phone: "9000000010", languages: ["English", "Hindi"] },
    contact: { name: "Demo Partner", phone: "9000000009", email: EMAIL, businessName: "Andaman Demo Travels" },
    description: "Comfortable AC SUV for local and outstation trips.",
  });

  await TaxiPackageModel.create({
    partner, status: "active", title: "Port Blair → Havelock 3D/2N Taxi Package",
    route: { origin: "Port Blair", destinations: ["Havelock", "Neil Island"], totalKm: 120, durationDays: 3, durationNights: 2 },
    vehicleSnapshot: { make: "Toyota", model: "Innova Crysta", type: "SUV", seatingCap: 7, images: ["/forest.jpg"] },
    itinerary: [{ day: 1, title: "Arrival & city tour", activities: ["Cellular Jail", "Corbyn's Cove"] }, { day: 2, title: "Havelock", activities: ["Radhanagar Beach"] }],
    pricing: { basePrice: 12000, currency: "INR", maxPersons: 6, tollsIncluded: true, driverAllowance: true, fuelIncluded: true },
    inclusions: ["Fuel", "Driver", "Tolls"], exclusions: ["Ferry tickets"],
    images: IMG, description: "Private taxi package across the islands.", highlights: ["Private cab", "Flexible itinerary"], tags: ["demo"],
  });

  await TourListingModel.create({
    partner, status: "active", title: "Cellular Jail & City Sightseeing Tour", category: "sightseeing", basedIn: "Port Blair",
    coversCities: ["Port Blair"], durationHours: 6,
    itinerary: [{ time: "09:00", title: "Cellular Jail", description: "Guided heritage walk" }, { time: "12:00", title: "Corbyn's Cove Beach" }],
    pricing: [{ label: "Adult", price: 1500, currency: "INR" }, { label: "Child", price: 900, currency: "INR" }],
    inclusions: ["Guide", "Entry tickets"], operatingDays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], startTimes: ["09:00"],
    images: IMG, description: "Half-day guided city tour.", highlights: ["Heritage", "Beach"], languages: ["English", "Hindi"], tags: ["demo"],
  });

  await TourPackageModel.create({
    partner, status: "active", title: "Andaman Explorer 4D/3N", packageType: "family",
    route: { origin: "Port Blair", destinations: ["Havelock", "Neil Island"], durationDays: 4, durationNights: 3 },
    customInclusions: ["Hotels", "Ferry", "Sightseeing"], exclusions: ["Flights"],
    itinerary: [{ day: 1, title: "Arrival Port Blair", meals: { breakfast: false, lunch: false, dinner: true } }, { day: 2, title: "Havelock", meals: { breakfast: true, lunch: false, dinner: true } }],
    pricing: { basePrice: 25000, currency: "INR", perPerson: true, maxPersons: 6, childPrice: 15000 },
    departures: [{ date: daysFromNow(14), seatsTotal: 20, status: "open" }, { date: daysFromNow(30), seatsTotal: 20, status: "open" }],
    images: IMG, description: "A family-friendly island getaway.", highlights: ["Beaches", "Ferry transfers"], tags: ["demo"],
  });

  await CruiseListingModel.create({
    partner, status: "active", cruiseName: "Makruzz Demo Cruise", cruiseType: "sea",
    vessel: { name: "Demo Vessel", operator: "Andaman Demo Travels", totalDecks: 2, images: IMG },
    route: { departurePort: "Port Blair", arrivalPort: "Havelock", durationDays: 1, durationNights: 0 },
    cabins: [{ type: "ocean_view", pricePerPerson: 3500 }, { type: "suite", pricePerPerson: 6000 }],
    shipAmenities: ["AC", "Cafe"], departures: [{ date: daysFromNow(7) }],
    description: "Fast, comfortable inter-island cruise.", highlights: ["Sea view"], tags: ["demo"],
  });

  await SightseeingListingModel.create({
    partner, status: "active", title: "Scuba Diving at Havelock", category: "water_activity",
    location: { address: "Havelock Island", island: "Havelock" },
    description: "Beginner-friendly scuba experience with certified instructors.",
    highlights: ["PADI instructors", "All gear included"], duration: { value: 3, unit: "hours" }, difficulty: "easy",
    inclusions: ["Gear", "Instructor", "Photos"], pricingModel: "per_person", currency: "INR",
    pricing: { adult: 3500, child: 2500 }, availableDays: ["mon", "wed", "fri", "sat", "sun"], timeSlots: ["08:00", "11:00"],
    cancellationPolicy: "free_24h", languages: ["English", "Hindi"], images: IMG, tags: ["demo"],
  });

  await TransferListingModel.create({
    partner, status: "active", title: "Airport → Hotel Private Transfer", transferType: "airport_pickup",
    coverageAreas: ["Port Blair"],
    routes: [{ from: "Veer Savarkar Airport", to: "Port Blair City", estimatedDuration: 30, estimatedDistance: 12, price: 1200 }],
    vehicles: [{ type: "sedan", makeModel: "Toyota Etios", maxPassengers: 4, maxLuggage: 3, basePrice: 1200, features: ["AC"] }],
    meetAndGreet: true, flightTracking: true, currency: "INR", cancellationPolicy: "free_24h",
    description: "Hassle-free airport pickups with flight tracking.", images: IMG, tags: ["demo"],
  });

  await SelfDriveListingModel.create({
    partner, status: "active", title: "Self-Drive SUV Rental — Port Blair",
    pickupLocations: [{ name: "Airport", address: "Veer Savarkar Airport" }],
    vehicles: [{ category: "suv", makeModel: "Mahindra Thar", year: 2023, transmission: "manual", fuelType: "diesel", seats: 4, dailyRate: 3000, mileagePolicy: "limited", kmPerDay: 150, fuelPolicy: "full_to_full", inventoryCount: 2 }],
    insuranceOptions: [{ tier: "standard", coverageDetails: "Third-party + CDW", dailySurcharge: 300 }],
    minRentalDays: 1, currency: "INR", cancellationPolicy: "free_24h",
    securityDeposit: { amount: 5000, method: "UPI/Card" },
    description: "Explore the island at your own pace.", images: IMG, tags: ["demo"],
  });

  await IslandhopperListingModel.create({
    partner, status: "active", title: "Port Blair ⇄ Havelock Ferry", serviceType: "ferry",
    routes: [{ origin: "Port Blair", destination: "Havelock", distance: 57, estimatedDuration: 90, isNonStop: true, oneWayFare: 1500, roundTripFare: 2800 }],
    schedule: [{ route: "Port Blair → Havelock", daysOfWeek: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], departureTimes: ["06:30", "14:00"], frequency: "Twice daily" }],
    vessel: { type: "Catamaran", capacity: 200, amenities: ["AC", "Snacks"] }, departurePoint: "Haddo Wharf",
    description: "Reliable inter-island ferry service.", tags: ["demo"], images: IMG,
  });

  await VisaListingModel.create({
    partner, status: "active", title: "Work & Study Visa Consultancy", licenceNumber: "DEMO-VISA-001",
    countriesCovered: ["Canada", "Australia", "UK"], visaTypesOffered: ["work", "study"],
    services: [{ visaCategory: "work", documentsRequired: ["Passport", "Offer letter"] }, { visaCategory: "study", documentsRequired: ["Passport", "Admission letter"] }],
    consultationModes: ["in_person", "video"], languages: ["English", "Hindi"],
    isFreeInitialConsultation: true, consultationFee: 2000, currency: "INR",
    description: "End-to-end visa filing and documentation support.", images: IMG, tags: ["demo"],
  });
}

// Marketplace Package catalog entries (drive the /packages grid + Holiday Packages)
// with an active PackageOffer each so the enquiry flow works.
async function seedMarketplacePackages(partner: mongoose.Types.ObjectId): Promise<void> {
  const defs: {
    kind: string; scope?: string; title: string; price: number; destinations: string[];
    days: number; nights: number; components?: { category: string; title: string; quantity: number; included: boolean }[];
  }[] = [
    { kind: "holiday", scope: "domestic", title: "Andaman Family Holiday 5D/4N", price: 32000, destinations: ["Port Blair", "Havelock", "Neil"], days: 5, nights: 4 },
    { kind: "holiday", scope: "international", title: "Bali Honeymoon Escape 6D/5N", price: 68000, destinations: ["Bali"], days: 6, nights: 5 },
    { kind: "tour_package", title: "Andaman Explorer 4D/3N", price: 25000, destinations: ["Havelock", "Neil"], days: 4, nights: 3 },
    { kind: "taxi_package", title: "Port Blair → Havelock Taxi Package", price: 12000, destinations: ["Havelock"], days: 3, nights: 2 },
    { kind: "tour", title: "Cellular Jail City Tour", price: 1500, destinations: ["Port Blair"], days: 1, nights: 0 },
    { kind: "cruise", title: "Inter-Island Sea Cruise", price: 3500, destinations: ["Havelock"], days: 1, nights: 0 },
    { kind: "sightseeing", title: "Scuba Diving Experience", price: 3500, destinations: ["Havelock"], days: 1, nights: 0 },
    { kind: "transfer", title: "Airport Private Transfer", price: 1200, destinations: ["Port Blair"], days: 1, nights: 0 },
    { kind: "self_drive", title: "Self-Drive SUV Rental", price: 3000, destinations: ["Port Blair"], days: 1, nights: 0 },
    { kind: "islandhopper", title: "Port Blair ⇄ Havelock Ferry", price: 1500, destinations: ["Havelock"], days: 1, nights: 0 },
    { kind: "visa", title: "Work Visa Consultancy", price: 2000, destinations: ["Canada"], days: 1, nights: 0 },
    {
      kind: "bundle", title: "Complete Andaman Bundle (Stay + Transfer + Tour)", price: 38000, destinations: ["Port Blair", "Havelock"], days: 5, nights: 4,
      components: [
        { category: "Stay", title: "Demo Sea View Resort — 4 nights", quantity: 4, included: true },
        { category: "Transfer", title: "Airport Private Transfer", quantity: 2, included: true },
        { category: "Sightseeing", title: "Scuba Diving Experience", quantity: 1, included: false },
      ],
    },
  ];

  for (const d of defs) {
    const place = d.destinations[0] ?? "the destination";
    const pkg = await PackageModel.create({
      kind: d.kind, scope: d.scope ?? "domestic", origin: "partner", author: partner, status: "active",
      title: d.title,
      description: `If you are planning a trip to ${d.destinations.join(", ")}, Andaman Demo Travels is the right place to come to. Whatever your travel preference, you will find suitable ${d.kind.replace(/_/g, " ")} options here — curated itineraries, transparent pricing and on-ground support throughout your journey.`,
      highlights: ["Curated by Andaman Demo Travels", "Best-price operator offers", "Instant enquiry — no upfront payment", "24×7 on-trip support"],
      route: { origin: "Port Blair", destinations: d.destinations, durationDays: d.days, durationNights: d.nights },
      itinerary: d.days > 1 ? buildItinerary(d.days, place) : [],
      components: d.components ?? [],
      inclusions: ["Welcome drink on arrival", "Daily breakfast", "Pick-up & drop (airport/port to hotel)", "All sightseeing & tour by car", "Applicable taxes"],
      exclusions: ["Flights unless stated", "Meals other than specified", "Monument & garden entry fees", "Adventure activities", "Anything not mentioned in inclusions"],
      specs: {
        cancellationPolicy: "Free cancellation up to 15 days before departure. 25% charge 8–14 days prior, 50% charge 3–7 days prior, and no refund within 48 hours of departure.",
        terms: "Prices are per person on twin-sharing and are confirmed by the operator on enquiry. Rooms, transfers and activities are subject to availability at the time of booking.",
        documents: "Carry a valid government photo ID for every traveller. For international trips a passport valid for at least 6 months and applicable visas are required.",
      },
      referencePrice: d.price, currency: "INR", images: gallery(d.kind + (d.scope ?? "")), thumbnail: gallery(d.kind + (d.scope ?? ""))[0].url, tags: ["demo"],
    });
    await PackageOfferModel.create({
      package: pkg._id, partner, price: d.price, currency: "INR", perPerson: false,
      notes: "Demo operator offer — contact for details.", status: "active",
      directContact: { name: "Andaman Demo Travels", phone: "9000000009", email: EMAIL }, showDirectContact: true,
    });
  }
}

async function main(): Promise<void> {
  await connectDb();
  const partner = await ensurePartner();
  await wipe(partner);
  await seedTypedListings(partner);
  await seedMarketplacePackages(partner);

  const counts = {
    packages: await PackageModel.countDocuments({ author: partner, status: "active" }),
    offers: await PackageOfferModel.countDocuments({ partner, status: "active" }),
  };

  console.log("\n  ✅ Demo partner + auto-approved listings seeded.\n");
  console.log(`  Login:    ${EMAIL}  /  ${PASSWORD}   (role: partner)`);
  console.log(`  Typed listings: hotel, taxi, taxi_package, tour, tour_package, cruise,`);
  console.log(`                  sightseeing, transfer, self_drive, islandhopper, visa (all active)`);
  console.log(`  Marketplace packages: ${counts.packages}  |  active offers: ${counts.offers}\n`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[seed:demo] failed:", err);
  process.exit(1);
});
