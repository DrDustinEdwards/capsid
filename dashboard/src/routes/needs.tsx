import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { NeedsYou } from "../views/NeedsYou";

export const loader = viewLoader("needs");
export const clientLoader = browserLoader;
export default viewPage(NeedsYou);
