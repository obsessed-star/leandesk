import { disableRoute } from "eve/channels";
// Prevent a second ingress from bypassing LeanDesk authorization and budgets.
export default disableRoute();
