import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { Settings } from "../views/Settings";

export const loader = viewLoader("settings");
export const clientLoader = browserLoader;
export default viewPage(Settings);
