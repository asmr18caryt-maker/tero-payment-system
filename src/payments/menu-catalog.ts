/**
 * Server-side price list used by the admin "test order" tool in the standalone
 * module. Item ids and prices match the live Tero menu at the time of writing
 * (prices in whole rupees). In the merged app, the existing menu data is the
 * source of truth instead.
 */
export const TEST_MENU: { id: string; name: string; priceRupees: number }[] = [
  { id: "cookie-crumbal-mocha", name: "Cookie Crumbal Mocha", priceRupees: 200 },
  { id: "espresso-bull", name: "Espresso Bull", priceRupees: 250 },
  { id: "teros-special-coffee", name: "Tero's Special", priceRupees: 250 },
  { id: "coco-dark-chocolate", name: "Coco Dark Chocolate", priceRupees: 160 },
  { id: "coco-crumbel", name: "Coco Crumbel", priceRupees: 180 },
  { id: "apple-pie-crunchy", name: "Apple Pie Crunchy", priceRupees: 200 },
  { id: "jawa-crunch-freppe", name: "Jawa Crunch Freppe", priceRupees: 200 },
  { id: "crunchy-mocha", name: "Crunchy Mocha", priceRupees: 220 },
];
