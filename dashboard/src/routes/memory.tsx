import { browserLoader, viewLoader, viewPage } from "../server/view-route";
import { Memory } from "../views/Memory";

export const loader = viewLoader("memory");
export const clientLoader = browserLoader;
const MemoryPage = viewPage(Memory);
export default MemoryPage;
