/**
 * Monitor worker job progress for mock user
 * Run: npx ts-node scripts/monitor-jobs.ts
 */

import prisma from '../src/prisma';

const MOCK_USER_ID = 'mock-user-001';

async function monitor() {
  const [events, interpretations, patterns, insights, reviews, dailyPlans, uomSuggestions] = await Promise.all([
    prisma.event.count({ where: { userId: MOCK_USER_ID } }),
    prisma.interpretation.count({ where: { userId: MOCK_USER_ID } }),
    prisma.pattern.findMany({
      where: { userId: MOCK_USER_ID },
      select: { id: true, status: true, reinforcementCount: true }
    }),
    prisma.insight.count({ where: { userId: MOCK_USER_ID } }),
    prisma.review.count({ where: { userId: MOCK_USER_ID } }),
    prisma.dailyPlan.count({ where: { userId: MOCK_USER_ID } }),
    prisma.uOMUpdateSuggestion.count({ where: { userId: MOCK_USER_ID } }),
  ]);

  const jobStats = await prisma.workerJob.groupBy({
    by: ['type', 'status'],
    where: { userId: MOCK_USER_ID },
    _count: true,
  });

  console.clear();
  console.log('═══════════════════════════════════════════════════');
  console.log('           JOB MONITOR - Mock User                 ');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log('📊 Data Summary:');
  console.log(`   Events:          ${events}`);
  console.log(`   Interpretations: ${interpretations}`);
  console.log(`   Patterns:        ${patterns.length} (${patterns.filter(p => p.status === 'ACTIVE').length} active)`);
  console.log(`   Insights:        ${insights}`);
  console.log(`   Reviews:         ${reviews}`);
  console.log(`   Daily Plans:     ${dailyPlans}`);
  console.log(`   UOM Suggestions: ${uomSuggestions}`);
  console.log('');

  if (patterns.length > 0) {
    console.log('📈 Pattern Reinforcements:');
    for (const p of patterns) {
      console.log(`   ${p.status.padEnd(10)} | reinforcements: ${p.reinforcementCount} | ${p.id.slice(0,12)}...`);
    }
    console.log('');
  }

  console.log('🔧 Job Status:');
  const jobTypes = ['INTERPRET_EVENT', 'DETECT_PATTERNS', 'GENERATE_INSIGHTS', 'GENERATE_REVIEW', 'GENERATE_TOMORROW_PLAN', 'SUGGEST_UOM_UPDATE'];

  for (const type of jobTypes) {
    const pending = jobStats.find(j => j.type === type && j.status === 'PENDING')?._count || 0;
    const processing = jobStats.find(j => j.type === type && j.status === 'PROCESSING')?._count || 0;
    const completed = jobStats.find(j => j.type === type && j.status === 'COMPLETED')?._count || 0;
    const failed = jobStats.find(j => j.type === type && j.status === 'DEAD_LETTER')?._count || 0;

    const total = pending + processing + completed + failed;
    if (total > 0) {
      const status = processing > 0 ? '🔄' : (pending > 0 ? '⏳' : '✅');
      console.log(`   ${status} ${type.padEnd(22)} P:${pending} | R:${processing} | C:${completed} | F:${failed}`);
    }
  }

  const totalPending = jobStats.filter(j => j.status === 'PENDING').reduce((sum, j) => sum + j._count, 0);
  const totalProcessing = jobStats.filter(j => j.status === 'PROCESSING').reduce((sum, j) => sum + j._count, 0);

  console.log('');
  console.log(`📍 Total: ${totalPending} pending, ${totalProcessing} processing`);
  console.log('');
  console.log('Press Ctrl+C to stop monitoring');
  console.log('═══════════════════════════════════════════════════');

  await prisma.$disconnect();
}

// Run once and exit, or loop
const args = process.argv.slice(2);
if (args.includes('--loop')) {
  setInterval(monitor, 5000);
  monitor();
} else {
  monitor();
}
