import type { Key, ReactNode } from "react";

export function DefinitionList({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="definition-list">
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RowList<T>({
  items,
  itemKey,
  children,
}: {
  items: T[];
  itemKey: (item: T) => Key;
  children: (item: T) => ReactNode;
}) {
  return (
    <div className="list">
      {items.map((item) => (
        <div className="row" key={itemKey(item)}>
          {children(item)}
        </div>
      ))}
    </div>
  );
}
