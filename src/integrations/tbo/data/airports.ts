import refData from "./airportReference.json";

export type Airport = {
  code: string;          // IATA
  name: string;
  city: string;
  country: string;
  countryCode: string;
  tz: string;
};

// Static names reference (IATA → [name, city, country, countryCode(ISO-2), tz]), the
// same dataset that backs the airport picker. The curated AIRPORTS below stay the
// priority source (hand-tuned), but getAirport()/searchAirports() fall back to this so
// the now-expanded set of bookable airports also resolves countryCode for the
// supplementary passport/visa pre-checks in validation.ts and ticket.ts.
const reference = refData as unknown as Record<string, [string, string, string, string, string]>;

function airportFromReference(code: string): Airport | null {
  const r = reference[code];
  if (!r) return null;
  return { code, name: r[0], city: r[1] || code, country: r[2], countryCode: r[3], tz: r[4] };
}

export const AIRPORTS: Airport[] = [
  // India
  { code: "DEL", name: "Indira Gandhi International Airport", city: "Delhi", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "BOM", name: "Chhatrapati Shivaji Maharaj International", city: "Mumbai", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "BLR", name: "Kempegowda International Airport", city: "Bengaluru", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "MAA", name: "Chennai International Airport", city: "Chennai", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "HYD", name: "Rajiv Gandhi International Airport", city: "Hyderabad", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "CCU", name: "Netaji Subhas Chandra Bose International", city: "Kolkata", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "GOI", name: "Dabolim Airport", city: "Goa", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "COK", name: "Cochin International Airport", city: "Kochi", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "AMD", name: "Sardar Vallabhbhai Patel International", city: "Ahmedabad", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "PNQ", name: "Pune Airport", city: "Pune", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "JAI", name: "Jaipur International Airport", city: "Jaipur", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "LKO", name: "Chaudhary Charan Singh International", city: "Lucknow", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "IXC", name: "Chandigarh International Airport", city: "Chandigarh", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "SXR", name: "Sheikh ul-Alam International Airport", city: "Srinagar", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "IXB", name: "Bagdogra International Airport", city: "Bagdogra", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "TRV", name: "Trivandrum International Airport", city: "Thiruvananthapuram", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "IXM", name: "Madurai Airport", city: "Madurai", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "VNS", name: "Lal Bahadur Shastri International", city: "Varanasi", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "PAT", name: "Jay Prakash Narayan International", city: "Patna", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },
  { code: "IXL", name: "Kushok Bakula Rimpochee Airport", city: "Leh", country: "India", countryCode: "IN", tz: "Asia/Kolkata" },

  // GCC / Middle East
  { code: "DXB", name: "Dubai International Airport", city: "Dubai", country: "United Arab Emirates", countryCode: "AE", tz: "Asia/Dubai" },
  { code: "AUH", name: "Abu Dhabi International Airport", city: "Abu Dhabi", country: "United Arab Emirates", countryCode: "AE", tz: "Asia/Dubai" },
  { code: "SHJ", name: "Sharjah International Airport", city: "Sharjah", country: "United Arab Emirates", countryCode: "AE", tz: "Asia/Dubai" },
  { code: "DOH", name: "Hamad International Airport", city: "Doha", country: "Qatar", countryCode: "QA", tz: "Asia/Qatar" },
  { code: "RUH", name: "King Khalid International Airport", city: "Riyadh", country: "Saudi Arabia", countryCode: "SA", tz: "Asia/Riyadh" },
  { code: "JED", name: "King Abdulaziz International Airport", city: "Jeddah", country: "Saudi Arabia", countryCode: "SA", tz: "Asia/Riyadh" },
  { code: "KWI", name: "Kuwait International Airport", city: "Kuwait City", country: "Kuwait", countryCode: "KW", tz: "Asia/Kuwait" },
  { code: "MCT", name: "Muscat International Airport", city: "Muscat", country: "Oman", countryCode: "OM", tz: "Asia/Muscat" },
  { code: "BAH", name: "Bahrain International Airport", city: "Manama", country: "Bahrain", countryCode: "BH", tz: "Asia/Bahrain" },

  // SE Asia
  { code: "SIN", name: "Changi Airport", city: "Singapore", country: "Singapore", countryCode: "SG", tz: "Asia/Singapore" },
  { code: "BKK", name: "Suvarnabhumi Airport", city: "Bangkok", country: "Thailand", countryCode: "TH", tz: "Asia/Bangkok" },
  { code: "DMK", name: "Don Mueang International", city: "Bangkok", country: "Thailand", countryCode: "TH", tz: "Asia/Bangkok" },
  { code: "KUL", name: "Kuala Lumpur International", city: "Kuala Lumpur", country: "Malaysia", countryCode: "MY", tz: "Asia/Kuala_Lumpur" },
  { code: "HKT", name: "Phuket International Airport", city: "Phuket", country: "Thailand", countryCode: "TH", tz: "Asia/Bangkok" },
  { code: "CGK", name: "Soekarno–Hatta International", city: "Jakarta", country: "Indonesia", countryCode: "ID", tz: "Asia/Jakarta" },
  { code: "DPS", name: "Ngurah Rai International", city: "Bali", country: "Indonesia", countryCode: "ID", tz: "Asia/Makassar" },
  { code: "MNL", name: "Ninoy Aquino International", city: "Manila", country: "Philippines", countryCode: "PH", tz: "Asia/Manila" },
  { code: "HAN", name: "Noi Bai International", city: "Hanoi", country: "Vietnam", countryCode: "VN", tz: "Asia/Ho_Chi_Minh" },
  { code: "SGN", name: "Tan Son Nhat International", city: "Ho Chi Minh City", country: "Vietnam", countryCode: "VN", tz: "Asia/Ho_Chi_Minh" },

  // Far East
  { code: "HKG", name: "Hong Kong International", city: "Hong Kong", country: "Hong Kong", countryCode: "HK", tz: "Asia/Hong_Kong" },
  { code: "NRT", name: "Narita International Airport", city: "Tokyo", country: "Japan", countryCode: "JP", tz: "Asia/Tokyo" },
  { code: "HND", name: "Haneda Airport", city: "Tokyo", country: "Japan", countryCode: "JP", tz: "Asia/Tokyo" },
  { code: "ICN", name: "Incheon International Airport", city: "Seoul", country: "South Korea", countryCode: "KR", tz: "Asia/Seoul" },
  { code: "PEK", name: "Beijing Capital International", city: "Beijing", country: "China", countryCode: "CN", tz: "Asia/Shanghai" },
  { code: "PVG", name: "Shanghai Pudong International", city: "Shanghai", country: "China", countryCode: "CN", tz: "Asia/Shanghai" },

  // Europe
  { code: "LHR", name: "Heathrow Airport", city: "London", country: "United Kingdom", countryCode: "GB", tz: "Europe/London" },
  { code: "LGW", name: "Gatwick Airport", city: "London", country: "United Kingdom", countryCode: "GB", tz: "Europe/London" },
  { code: "CDG", name: "Charles de Gaulle Airport", city: "Paris", country: "France", countryCode: "FR", tz: "Europe/Paris" },
  { code: "FRA", name: "Frankfurt Airport", city: "Frankfurt", country: "Germany", countryCode: "DE", tz: "Europe/Berlin" },
  { code: "MUC", name: "Munich Airport", city: "Munich", country: "Germany", countryCode: "DE", tz: "Europe/Berlin" },
  { code: "AMS", name: "Schiphol Airport", city: "Amsterdam", country: "Netherlands", countryCode: "NL", tz: "Europe/Amsterdam" },
  { code: "FCO", name: "Leonardo da Vinci–Fiumicino", city: "Rome", country: "Italy", countryCode: "IT", tz: "Europe/Rome" },
  { code: "MAD", name: "Adolfo Suárez Madrid–Barajas", city: "Madrid", country: "Spain", countryCode: "ES", tz: "Europe/Madrid" },
  { code: "IST", name: "Istanbul Airport", city: "Istanbul", country: "Turkey", countryCode: "TR", tz: "Europe/Istanbul" },
  { code: "ZRH", name: "Zurich Airport", city: "Zurich", country: "Switzerland", countryCode: "CH", tz: "Europe/Zurich" },

  // Americas
  { code: "JFK", name: "John F. Kennedy International", city: "New York", country: "United States", countryCode: "US", tz: "America/New_York" },
  { code: "EWR", name: "Newark Liberty International", city: "Newark", country: "United States", countryCode: "US", tz: "America/New_York" },
  { code: "LAX", name: "Los Angeles International", city: "Los Angeles", country: "United States", countryCode: "US", tz: "America/Los_Angeles" },
  { code: "SFO", name: "San Francisco International", city: "San Francisco", country: "United States", countryCode: "US", tz: "America/Los_Angeles" },
  { code: "ORD", name: "O'Hare International Airport", city: "Chicago", country: "United States", countryCode: "US", tz: "America/Chicago" },
  { code: "YYZ", name: "Toronto Pearson International", city: "Toronto", country: "Canada", countryCode: "CA", tz: "America/Toronto" },

  // Oceania
  { code: "SYD", name: "Kingsford Smith Airport", city: "Sydney", country: "Australia", countryCode: "AU", tz: "Australia/Sydney" },
  { code: "MEL", name: "Melbourne Airport", city: "Melbourne", country: "Australia", countryCode: "AU", tz: "Australia/Melbourne" },
  { code: "AKL", name: "Auckland Airport", city: "Auckland", country: "New Zealand", countryCode: "NZ", tz: "Pacific/Auckland" },

  // Indian Subcontinent
  { code: "KTM", name: "Tribhuvan International", city: "Kathmandu", country: "Nepal", countryCode: "NP", tz: "Asia/Kathmandu" },
  { code: "CMB", name: "Bandaranaike International", city: "Colombo", country: "Sri Lanka", countryCode: "LK", tz: "Asia/Colombo" },
  { code: "MLE", name: "Velana International", city: "Male", country: "Maldives", countryCode: "MV", tz: "Indian/Maldives" },
  { code: "DAC", name: "Hazrat Shahjalal International", city: "Dhaka", country: "Bangladesh", countryCode: "BD", tz: "Asia/Dhaka" },
];

export function searchAirports(q: string, limit = 10): Airport[] {
  const query = q.trim().toLowerCase();
  if (!query) {
    return [
      "DEL", "BOM", "BLR", "MAA", "HYD", "GOI", "DXB", "SIN", "BKK", "LHR",
    ]
      .map((code) => AIRPORTS.find((a) => a.code === code)!)
      .filter(Boolean)
      .slice(0, limit);
  }
  const scored = AIRPORTS.map((a) => {
    let score = 0;
    if (a.code.toLowerCase() === query) score += 100;
    else if (a.code.toLowerCase().startsWith(query)) score += 60;
    if (a.city.toLowerCase().startsWith(query)) score += 50;
    else if (a.city.toLowerCase().includes(query)) score += 20;
    if (a.name.toLowerCase().includes(query)) score += 10;
    if (a.country.toLowerCase().startsWith(query)) score += 8;
    return { a, score };
  })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((x) => x.a);
  return scored;
}

export function getAirport(code: string) {
  const upper = code.toUpperCase();
  return AIRPORTS.find((a) => a.code === upper) ?? airportFromReference(upper);
}
