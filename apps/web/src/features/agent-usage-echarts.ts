import { LineChart } from "echarts/charts";
import { BrushComponent, GridComponent, ToolboxComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

/*
 * The chart's echarts registration lives in a module of its own so the imports above can be static.
 * Awaiting `import("echarts/charts")` directly asks for the whole module namespace, and Rollup cannot
 * prove which of its bindings a caller reads, so it keeps every one — all 22 chart types and every
 * component, map projections included. Static named imports are traceable, so only what is named here
 * survives; the lazy boundary moves out to whoever imports this module.
 */
echarts.use([LineChart, BrushComponent, GridComponent, ToolboxComponent, TooltipComponent, CanvasRenderer]);

export { echarts };
