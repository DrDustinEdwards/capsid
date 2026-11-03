import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { Queue } from "../views/Queue";

export const loader = viewLoader("queue");
export const clientLoader = browserLoader;
export default viewPage(Queue);
