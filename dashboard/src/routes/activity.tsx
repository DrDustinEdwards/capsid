import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { Activity } from "../views/Activity";

export const loader = viewLoader("activity");
export const clientLoader = browserLoader;
export default viewPage(Activity);
