import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { Library } from "../views/Library";

export const loader = viewLoader("library");
export const clientLoader = browserLoader;
export default viewPage(Library);
