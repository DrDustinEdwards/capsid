import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { Agents } from "../views/Agents";

export const loader = viewLoader("agents");
export const clientLoader = browserLoader;
export default viewPage(Agents);
