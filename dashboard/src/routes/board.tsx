import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { Board } from "../views/Board";

export const loader = viewLoader("board");
export const clientLoader = browserLoader;
const BoardPage = viewPage(Board);
export default BoardPage;
