"use client";

import dynamic from "next/dynamic";

export const SearchTrendChart = dynamic(
  () =>
    import("./search-trend-chart").then((module) => module.SearchTrendChart),
  {
    ssr: false,
    loading: () => <div className="dash-search-chart is-loading" />,
  },
);
