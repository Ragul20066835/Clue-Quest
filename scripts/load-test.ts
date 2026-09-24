const BASE_URL = "http://localhost:3001";
const TOKEN = process.env.CQ_TOKEN;

if (!TOKEN) {
  console.error("CQ_TOKEN environment variable missing");
  process.exit(1);
}

const TOTAL_REQUESTS = 40;

async function run() {
  console.log(`Starting ${TOTAL_REQUESTS} concurrent /api/game/state requests...`);

  const start = performance.now();

  const results = await Promise.all(
    Array.from({ length: TOTAL_REQUESTS }, async (_, i) => {
      const requestStart = performance.now();

      try {
        const response = await fetch(`${BASE_URL}/api/game/state`, {
          headers: {
            Authorization: `Bearer ${TOKEN}`,
          },
        });

        const duration = performance.now() - requestStart;

        return {
          id: i + 1,
          ok: response.ok,
          status: response.status,
          duration,
        };
      } catch (error) {
        return {
          id: i + 1,
          ok: false,
          status: 0,
          duration: performance.now() - requestStart,
          error: String(error),
        };
      }
    })
  );

  const total = performance.now() - start;
  const successful = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  const times = results.map(r => r.duration);

  console.log("\n=== CLUE QUEST GAME STATE LOAD TEST ===");
  console.log(`Concurrent requests : ${TOTAL_REQUESTS}`);
  console.log(`Successful          : ${successful.length}`);
  console.log(`Failed              : ${failed.length}`);
  console.log(`Total time          : ${total.toFixed(2)} ms`);
  console.log(`Min response        : ${Math.min(...times).toFixed(2)} ms`);
  console.log(`Max response        : ${Math.max(...times).toFixed(2)} ms`);
  console.log(
    `Average response    : ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2)} ms`
  );

  if (failed.length > 0) {
    console.log("\nFailed requests:");
    console.log(failed);
    process.exit(1);
  }

  console.log("\n? All concurrent gameplay requests succeeded.");
}

run();
