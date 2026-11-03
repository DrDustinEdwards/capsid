import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { PullRequests } from "../views/Ci";

export const loader = viewLoader("prs");
export const clientLoader = browserLoader;
export default viewPage(PullRequests);
