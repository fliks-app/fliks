import { CronExpressionParser } from 'cron-parser';
import { emit } from './_util';

const EXPRS = [
  '0 0 1 1 *', '* * * * *', '*/5 * * * *', '0 */6 * * *', '30 2 * * 1-5', '0 0 * * sun', '0 0 * * SUN-SAT', '0 0 1,15 * *',
  '0 0 L * *', '0 0 * * 5L', '0 0 * * 1#2', '0 0 29 2 *', '0 0 31 4 *', '*/10 * * * * *', '0 30 2 * * *', '0 0 0 1 1 * 2027',
  '', ' ', 'x', '* * * *', '* * * * * * *', '60 * * * *', '* 24 * * *', '* * 32 * *', '* * * 13 *', '* * * * 8',
  '0 0 * * 7', '*/0 * * * *', '5-1 * * * *', '0 0 ? * *', '@daily', '@hourly', '@yearly', '@reboot', '0 0 1 jan *',
  '0 0 1 JAN-MAR *', '1-60/5 * * * *', '0  0  *  *  *', '\t0 0 * * *', '0 0 * * * ', '0,  1 * * * *', 'H * * * *',
  '0 0 W * *', '0 0 15W * *', '0 0 LW * *', '0 0 * * MON#5', '-1 * * * *', '1.5 * * * *', '0 0 1-31/2 * *', '*/15 9-17 * * 1-5',
];

const inputs = EXPRS.map((cron) => ({ cron }));

function run(i: { cron: string }): unknown {
  try {
    CronExpressionParser.parse(i.cron);
    return { valid: true };
  } catch {
    return { valid: false };
  }
}

void emit('cron-validate', inputs, run);
