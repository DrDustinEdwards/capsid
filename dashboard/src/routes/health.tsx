import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { Health } from "../views/Health";

export const loader = viewLoader("health");
export const clientLoader = browserLoader;
const HealthPage = viewPage(Health);
export default HealthPage;
