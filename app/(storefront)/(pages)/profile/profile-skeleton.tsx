// The profile page's loading state.
//
// It mirrors the real layout — same header, same two columns, same card and
// field geometry — so the content lands into a shape that is already on screen
// rather than replacing a blank page. AuthProvider holds `loading` until the
// customer ROW arrives (§4), which is a full round trip, so this is on screen
// long enough to matter.
//
// ★ It shows only the cards that ALWAYS render. There is no store-credit
// skeleton: most shoppers have no credit, and a card that shimmers and then
// disappears is worse than one that simply arrives.

import styles from "./profile.module.css";

function Field() {
  return (
    <div className={styles.inputGroup}>
      <span className={`${styles.skel} ${styles.skelLabel}`} />
      <span className={`${styles.skel} ${styles.skelInput}`} />
    </div>
  );
}

function CardHead() {
  return (
    <div className={styles.cardHeader}>
      <span className={`${styles.skel} ${styles.skelCardTitle}`} />
      <span className={`${styles.skel} ${styles.skelCardSub}`} />
    </div>
  );
}

export default function ProfileSkeleton() {
  return (
    <div className={styles.container}>
      <div className={styles.content} role="status" aria-live="polite">
        {/* A shimmer says nothing to a screen reader. */}
        <span className={styles.srOnly}>Loading your account…</span>

        <div className={styles.header}>
          <span className={`${styles.skel} ${styles.skelAvatar}`} />
          <div className={styles.headerText}>
            <span className={`${styles.skel} ${styles.skelTitle}`} />
            <span className={`${styles.skel} ${styles.skelSub}`} />
          </div>
        </div>

        <div className={styles.layout}>
          <div className={styles.mainCol}>
            <div className={`${styles.card} ${styles.slotPersonal}`}>
              <CardHead />
              <div className={styles.form}>
                <div className={styles.formRow}>
                  <Field />
                  <Field />
                </div>
                <Field />
                <Field />
                <div className={styles.formActions}>
                  <span className={`${styles.skel} ${styles.skelButton}`} />
                </div>
              </div>
            </div>

            <div className={`${styles.card} ${styles.slotAddress}`}>
              <CardHead />
              <div className={styles.skelRows}>
                <span className={`${styles.skel} ${styles.skelRow}`} />
              </div>
            </div>
          </div>

          <aside className={styles.sideCol}>
            <div className={`${styles.card} ${styles.slotActivity}`}>
              <CardHead />
              <div className={styles.skelRows}>
                <span className={`${styles.skel} ${styles.skelRow}`} />
                <span className={`${styles.skel} ${styles.skelRow}`} />
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
