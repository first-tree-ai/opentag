import { BarChart } from "echarts/charts";
import { AriaComponent, BrushComponent, GridComponent, ToolboxComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

/*
 * The chart's echarts registration lives in a module of its own so the imports above can be static.
 * Awaiting `import("echarts/charts")` directly asks for the whole module namespace, and Rollup cannot
 * prove which of its bindings a caller reads, so it keeps every one — all 22 chart types and every
 * component, map projections included. Static named imports are traceable, so only what is named here
 * survives; the lazy boundary moves out to whoever imports this module.
 */
echarts.use([
  AriaComponent,
  BarChart,
  BrushComponent,
  GridComponent,
  ToolboxComponent,
  TooltipComponent,
  CanvasRenderer,
]);

// Usage is bucketed by UTC day, even in the rolling 24-hour window.
echarts.registerPreprocessor((option) => {
  option.useUTC = true;
  const axes = Array.isArray(option.xAxis) ? option.xAxis : [option.xAxis];
  for (const axis of axes) {
    if (axis?.type === "time") {
      axis.minInterval = 86_400_000;
      axis.axisLabel = { ...axis.axisLabel, hideOverlap: true, showMinLabel: true, showMaxLabel: true };
    }
  }
  const series = Array.isArray(option.series) ? option.series : [option.series];
  for (const item of series) {
    // A short window may contain only one or two days; keep its bars proportionate.
    if (item?.type === "bar") item.barMaxWidth = 24;
  }
});

export { echarts };
