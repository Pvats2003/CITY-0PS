export const AREAS = [
  "Koramangala",
  "Indiranagar",
  "HSR Layout",
  "Whitefield",
  "Jayanagar",
  "MG Road",
  "Electronic City",
  "BTM Layout",
];

export interface BusinessSeed {
  name: string;
  category: string;
  area: string;
  windowed?: [string, string];
}

export const BUSINESS_SEEDS: BusinessSeed[] = [
  { name: "Spice Route Kitchen", category: "Restaurant", area: "Koramangala", windowed: ["11:00", "15:00"] },
  { name: "Urban Grocer", category: "Grocery", area: "Indiranagar" },
  { name: "TechHub Electronics", category: "Electronics", area: "HSR Layout" },
  { name: "Fresh Fields Bakery", category: "Bakery", area: "Jayanagar", windowed: ["07:30", "11:00"] },
  { name: "MetroMart Retail", category: "Retail", area: "MG Road" },
  { name: "Precision Auto Works", category: "Auto Service", area: "Electronic City" },
  { name: "GreenLeaf Pharmacy", category: "Pharmacy", area: "BTM Layout" },
  { name: "Craft & Comfort Furniture", category: "Furniture", area: "Whitefield" },
  { name: "Sunrise Hardware", category: "Hardware", area: "Koramangala" },
  { name: "Elegance Apparel Co.", category: "Apparel", area: "Indiranagar", windowed: ["13:00", "18:00"] },
  { name: "Northgate Warehouse", category: "Warehouse", area: "Whitefield" },
  { name: "Bloom Florist Studio", category: "Retail", area: "Jayanagar" },
  { name: "Rapid Print & Copy", category: "Services", area: "MG Road" },
  { name: "Coastal Seafood Market", category: "Grocery", area: "HSR Layout", windowed: ["08:00", "12:00"] },
  { name: "Aria Home Decor", category: "Retail", area: "BTM Layout" },
  { name: "Vertex Manufacturing", category: "Manufacturing", area: "Electronic City" },
  { name: "Blue Ridge Cafe", category: "Restaurant", area: "Indiranagar", windowed: ["09:00", "13:00"] },
  { name: "Kingsley Bookstore", category: "Retail", area: "Koramangala" },
];

export const FO_SEEDS = [
  { name: "Arjun Mehta", homeArea: "Koramangala" },
  { name: "Priya Nair", homeArea: "Indiranagar" },
  { name: "Rahul Verma", homeArea: "HSR Layout" },
  { name: "Sneha Kulkarni", homeArea: "Whitefield" },
  { name: "Vikram Singh", homeArea: "Jayanagar" },
];

export const COLLECTOR_NAMES = [
  "Anil Kumar",
  "Divya Reddy",
  "Karthik Iyer",
  "Meera Pillai",
  "Suresh Babu",
  "Lakshmi Menon",
  "Rohit Gupta",
  "Pooja Shetty",
  "Naveen Rao",
  "Kavya Krishnan",
  "Manoj Tiwari",
  "Deepa Joshi",
];

export const RIG_MODELS = ["FieldCam RX2", "FieldCam RX2 Mini", "FieldCam Pro X3"];
