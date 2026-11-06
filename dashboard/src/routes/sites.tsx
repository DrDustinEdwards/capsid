import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { Sites } from "../views/Sites";

export const loader = viewLoader("sites");
export const clientLoader = browserLoader;
export default viewPage(Sites);
