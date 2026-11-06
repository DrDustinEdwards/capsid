import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { SitePage } from "../views/SitePage";

export const loader = viewLoader("sites");
export const clientLoader = browserLoader;
const SitePagePage = viewPage(SitePage);
export default SitePagePage;
