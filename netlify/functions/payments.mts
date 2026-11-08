import type { Config } from "@netlify/functions";
import { routePaymentRequest } from "../../src/payments/router.js";

export default (req: Request) => routePaymentRequest(req);

export const config: Config = {
  path: ["/api/payments", "/api/payments/*"],
};
