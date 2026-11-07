import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { Settings } from "../views/Settings";

export const loader = viewLoader("settings");
export const clientLoader = browserLoader;
const SettingsPage = viewPage(Settings);
export default SettingsPage;
