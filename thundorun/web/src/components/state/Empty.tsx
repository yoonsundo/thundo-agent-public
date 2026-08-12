/**
 * Empty — 빈 상태. DESIGN.md §4.14 / §6.
 * 다음 행동은 하나만 제시한다(주 액션 1개).
 */
export default function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-mark" />
      <span className="empty-title">{title}</span>
      {body && <p className="empty-body">{body}</p>}
      {action}
    </div>
  );
}
