import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { Packages } from "../views/Packages";

export const loader = viewLoader("packages");
export const clientLoader = browserLoader;
export default viewPage(Packages);
