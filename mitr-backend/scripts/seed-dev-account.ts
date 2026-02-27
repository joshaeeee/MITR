import dotenv from 'dotenv';
import { AuthService } from '../src/services/auth/auth-service.js';
import { FamilyService } from '../src/services/family/family-service.js';
import { ElderService } from '../src/services/elder/elder-service.js';
import { CareService } from '../src/services/care/care-service.js';
import { ProfileService } from '../src/services/profile/profile-service.js';
import { logger } from '../src/lib/logger.js';

dotenv.config({ path: '.env' });

const EMAIL = 'tester@gmail.com';
const PASSWORD = '12345678910';
const NAME = 'Tester Family';

const run = async () => {
  const auth = new AuthService();
  const family = new FamilyService();
  const elder = new ElderService();
  const care = new CareService();
  const profile = new ProfileService();

  let user = await auth.getUserByEmail(EMAIL);
  if (!user) {
    const created = await auth.signupEmail({ email: EMAIL, password: PASSWORD, name: NAME });
    user = created.user;
    logger.info('Seed user created', { email: EMAIL, userId: user.id });
  } else {
    logger.info('Seed user already exists', { email: EMAIL, userId: user.id });
  }

  await family.getFamilyMe(user.id);

  await elder.upsertProfile(user.id, {
    name: 'Kamla Devi',
    ageRange: '70-79',
    language: 'hi-IN',
    city: 'Almora',
    timezone: 'Asia/Kolkata'
  });

  await elder.linkDevice(user.id, {
    serialNumber: 'MITR-TEST-0001',
    firmwareVersion: 'v1.0.0'
  });

  const reminders = await care.listReminders(user.id);
  if (!reminders.some((r) => r.title.toLowerCase() === 'morning medicine')) {
    await care.createReminder(user.id, {
      title: 'Morning medicine',
      description: 'After breakfast',
      scheduledTime: '08:00',
      enabled: true
    });
  }

  await profile.saveAnswers(user.id, {
    name: NAME,
    language: 'hi-IN',
    region: 'Almora, Uttarakhand',
    appLanguage: 'en'
  });

  logger.info('Seed complete', { email: EMAIL, userId: user.id });
};

run().catch((error) => {
  logger.error('Seed failed', { error: (error as Error).message });
  process.exit(1);
});
