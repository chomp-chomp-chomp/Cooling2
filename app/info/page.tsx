import type { Metadata } from "next";
import styles from "./info.module.css";

export const metadata: Metadata = {
  title: "Cooling — Info",
  description: "Cooling info sheet",
};

export default function InfoPage() {
  return (
    <main className={styles.container}>
      <h1 className={styles.heading}>Cooling</h1>

      <div className={styles.title}>Servings</div>
      <br />
      <div className={styles.textBlock}>
        Cooling is a small, private mobile app for two people.
        {"\n\n"}
        Either person can perform a single action called Chomp.
        {"\n\n"}
        A Chomp sends a quiet buzz to the other person. The notification contains
        no message, explanation, or instruction.
        {"\n\n"}
        A Chomp also places something in the oven for the sender for exactly 108
        seconds.
        {"\n\n"}
        While something is in the oven, the app shows &quot;in the oven • N
        seconds&quot;. When the oven time ends, the app returns to
        &quot;Cooling&quot;.
        {"\n\n"}
        There is no chat.
        {"\n"}
        There are no replies.
        {"\n"}
        There is no obligation to respond.
      </div>
      <br />

      <div className={styles.divider}></div>
      <br />

      <div className={styles.title}>Ingredients</div>
      <br />
      <div className={styles.textBlock}>
        Cooling never names what is in the oven. It may be affection, irritation,
        longing, attention, grief, or nothing in particular.
        {"\n\n"}
        Naming it would turn it into content.
        {"\n"}
        Measuring it would turn it into work.
        {"\n\n"}
        The app leaves it unspecified on purpose.
        {"\n\n"}
        Each person&apos;s oven is independent. There is no turn-taking and no
        synchronization. It shows only one historical signal: &quot;last chomp:
        just now / 12m ago / 3h ago / yesterday&quot;.
        {"\n\n"}
        The app enforces restraint quietly and without reward.
        {"\n\n"}
        The oven time is finite and precise.
        {"\n"}
        Everything else is cooling.
      </div>

      <br />
      <div className={styles.divider}></div>
      <br />

      <div className={styles.title}>Nutrition</div>
      <br />
      <div className={styles.textBlock}>
        Cooling deliberately avoids messaging threads, read receipts, presence
        indicators, analytics, streaks, reminders, and growth mechanics.
        {"\n\n"}
        These features convert care into labor and attention into performance.
        {"\n\n"}
        Cooling refuses that conversion.
      </div>

      <br />
      <div className={styles.divider}></div>
      <br />

      <div className={styles.title}>Done</div>
      <br />
      <div className={styles.textBlock}>
        Cooling is complete by design.
        {"\n\n"}
        It has no roadmap.
        {"\n"}
        It does not seek improvement through addition.
        {"\n\n"}
        There is no recipe.
        {"\n\n"}
        If it adds replies, metrics, optimization, or explanation, it should be
        considered broken.
        {"\n\n"}
        Cooling is everything besides putting something briefly in the oven.
      </div>
      <br />
      <div className={styles.divider}></div>
      <br />

      <nav className={styles.nav}>
        <a href="https://chomp.chom.pm" className={styles.backLink}>
          app →
        </a>
      </nav>
    </main>
  );
}
