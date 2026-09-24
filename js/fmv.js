// Fair market value guide for commonly donated goods.
// Ranges are typical thrift-store resale prices drawn from the valuation guides that
// large charities (Salvation Army, Goodwill) publish. FMV is what a willing buyer would
// pay a willing seller for the item in its current condition — not what you paid.
// Adjust within (or outside) the range to match the item's actual condition and age.
window.FMV_GUIDE = [
  { cat: "Women's clothing", items: [
    ["Blouse / top", 3, 12], ["Dress", 4, 20], ["Skirt", 3, 8], ["Pants / slacks", 4, 12], ["Jeans", 4, 15],
    ["Sweater", 4, 13], ["Suit (2-piece)", 6, 25], ["Coat / overcoat", 10, 40], ["Jacket", 7, 20], ["Shoes (pair)", 3, 30],
    ["Boots (pair)", 5, 35], ["Handbag / purse", 2, 20], ["Evening dress / formal", 10, 60], ["Swimsuit", 3, 8], ["Nightgown / robe", 3, 12] ] },
  { cat: "Men's clothing", items: [
    ["Shirt (dress or casual)", 3, 12], ["T-shirt", 1, 6], ["Pants / slacks", 4, 12], ["Jeans", 4, 15], ["Shorts", 3, 8],
    ["Sweater", 3, 15], ["Suit (2-piece)", 15, 60], ["Sport coat / blazer", 8, 25], ["Overcoat", 15, 60], ["Jacket", 7, 25],
    ["Shoes (pair)", 3, 30], ["Boots (pair)", 5, 35], ["Tie", 1, 5], ["Belt", 1, 5] ] },
  { cat: "Children's clothing", items: [
    ["Shirt / top", 2, 6], ["Pants / jeans", 2, 10], ["Dress", 3, 12], ["Sweater", 3, 8], ["Coat", 5, 20], ["Snowsuit", 4, 19],
    ["Shoes (pair)", 3, 10], ["Boots (pair)", 3, 15], ["Pajamas", 2, 6], ["Baby clothing (per piece)", 1, 4] ] },
  { cat: "Furniture", items: [
    ["Sofa / couch", 35, 200], ["Loveseat", 25, 100], ["Upholstered chair", 25, 100], ["Recliner", 25, 120], ["Coffee table", 15, 65],
    ["End table", 10, 50], ["Dining table", 35, 135], ["Dining chair (each)", 5, 30], ["Dining room set (table + 4-6 chairs)", 150, 900],
    ["Bed frame + headboard (full/queen)", 50, 170], ["Mattress & box spring (clean)", 25, 100], ["Dresser / chest of drawers", 20, 100], ["Nightstand", 10, 40],
    ["Desk", 25, 140], ["Bookcase", 15, 75], ["Floor lamp", 8, 35], ["Table lamp", 5, 25], ["Rug (area, 5x8 or larger)", 20, 90], ["Entertainment center / TV stand", 20, 100],
    ["Crib (must meet current safety standards)", 25, 100], ["Patio set", 25, 150] ] },
  { cat: "Appliances", items: [
    ["Refrigerator (working)", 50, 250], ["Range / stove", 50, 200], ["Washing machine", 40, 150], ["Dryer", 45, 100], ["Dishwasher", 30, 125],
    ["Microwave", 10, 50], ["Window air conditioner", 20, 90], ["Vacuum cleaner", 15, 65], ["Space heater", 5, 25], ["Toaster / small kitchen appliance", 3, 15],
    ["Coffee maker", 4, 20], ["Blender / mixer", 5, 25], ["Sewing machine", 15, 75] ] },
  { cat: "Electronics", items: [
    ["Flat-screen TV (working)", 40, 225], ["Laptop (working, recent)", 50, 300], ["Desktop computer", 40, 200], ["Computer monitor", 10, 60],
    ["Printer", 5, 50], ["Tablet", 20, 120], ["Smartphone (unlocked, working)", 20, 150], ["Stereo / speaker system", 15, 75], ["DVD / Blu-ray player", 5, 20],
    ["Video game console", 20, 120], ["Camera (digital)", 15, 100], ["Radio / clock radio", 3, 15] ] },
  { cat: "Sporting goods & outdoor", items: [
    ["Adult bicycle", 15, 75], ["Child bicycle", 5, 30], ["Golf clubs (full set with bag)", 25, 120], ["Golf club (single)", 2, 25],
    ["Tennis racket", 2, 15], ["Skis with bindings (pair)", 10, 60], ["Snowboard", 15, 60], ["Treadmill (working)", 50, 200],
    ["Exercise bike", 20, 90], ["Weight set", 10, 50], ["Camping tent", 10, 60], ["Sleeping bag", 5, 25], ["Fishing rod & reel", 5, 30], ["Kayak / canoe", 50, 250] ] },
  { cat: "Household & kitchen", items: [
    ["Blanket / comforter", 3, 24], ["Bedspread / quilt", 3, 24], ["Sheet set", 2, 8], ["Pillow", 2, 8], ["Towel (bath)", 1, 4],
    ["Curtains / drapes (pair)", 2, 12], ["Dish set (service for 4+)", 10, 30], ["Glassware (each)", 0.5, 1.5], ["Cookware set (pots & pans)", 5, 30],
    ["Kitchen utensils (each)", 0.5, 1.5], ["Small decor / vase / picture frame", 1, 10], ["Framed art / print", 5, 40], ["Christmas / holiday decor (box)", 3, 20],
    ["Luggage (suitcase)", 5, 25], ["Tools (hand tool, each)", 1, 8], ["Power tool (working)", 10, 60], ["Lawn mower (working)", 25, 100] ] },
  { cat: "Books, media & toys", items: [
    ["Hardcover book", 1, 3], ["Paperback book", 0.75, 2], ["Textbook (recent edition)", 2, 15], ["Children's book", 0.5, 2],
    ["DVD / Blu-ray", 1, 3], ["CD", 1, 2], ["Vinyl record", 1, 5], ["Video game", 2, 15], ["Board game (complete)", 2, 8], ["Puzzle (complete)", 1, 3],
    ["Stuffed animal", 0.5, 3], ["Toy (small)", 0.5, 3], ["Toy (large, ride-on or playset)", 5, 40], ["Doll / action figure", 1, 5], ["Stroller", 5, 40], ["Car seat (unexpired, never in a crash)", 10, 40] ] }
];

window.FMV_CONDITIONS = [
  ["excellent", "Excellent — like new", 1.0],
  ["good", "Good — normal wear, fully usable", 0.6],
  ["fair", "Fair — visibly worn (generally NOT deductible for clothing & household items)", 0.25]
];

window.FMV_METHODS = [
  "Thrift-store / charity valuation guide",
  "Comparable sales (eBay, Facebook Marketplace, Craigslist)",
  "Charity's own price list",
  "Qualified appraisal",
  "Catalog / dealer price for used items",
  "Other (describe in notes)"
];

// Appraisal groups: "similar items" for the IRS $5,000 aggregation test are grouped by kind of
// property, not by the shopping category above. Guide category → group.
window.FMV_GROUPS = {
  "Women's clothing": "Clothing", "Men's clothing": "Clothing", "Children's clothing": "Clothing",
  "Furniture": "Furniture", "Appliances": "Appliances", "Electronics": "Electronics",
  "Sporting goods & outdoor": "Sporting goods", "Household & kitchen": "Household items",
  "Books, media & toys": "Toys & games",   // default for the mixed category; keywords below split it
  "Art & collectibles": "Art & collectibles", "Jewelry & watches": "Jewelry", "Vehicles": "Vehicles", "Other": "Other"
};
// Keyword overrides checked against the item description, first match wins.
window.FMV_GROUP_KEYWORDS = [
  [/\b(book|textbook|paperback|hardcover|novel|encyclopedia)s?\b/, "Books"],
  [/\b(dvd|blu-?ray|cd|vinyl|record|video game|cassette)s?\b/, "Media"],
  [/\b(painting|print|sculpture|artwork|antique|collectible|coin|stamp)s?\b/, "Art & collectibles"],
  [/\b(ring|necklace|bracelet|earring|watch|jewel)s?\b/, "Jewelry"],
  [/\b(car|truck|suv|van|boat|trailer|motorcycle|airplane)\b(?! seat)/, "Vehicles"]
];
// Extra categories offered on the item row that have no guide values (appraisal-relevant property).
window.FMV_EXTRA_CATEGORIES = ["Art & collectibles", "Jewelry & watches", "Vehicles"];
