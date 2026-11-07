import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { Projects } from "../views/Projects";

export const loader = viewLoader("projects");
export const clientLoader = browserLoader;
const ProjectsPage = viewPage(Projects);
export default ProjectsPage;
