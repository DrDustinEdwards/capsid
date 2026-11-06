import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { Projects } from "../views/Projects";

export const loader = viewLoader("projects");
export const clientLoader = browserLoader;
export default viewPage(Projects);
