import axios from 'axios';
import tough from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import fs, { stat } from 'fs';
import path from 'path';
import { mkdirp } from 'mkdirp';
import { program } from 'commander';
import chalk from 'chalk';


async function login({ username, password, cookieJarPath }) {
  const jar = new tough.CookieJar();
  const client = wrapper(axios.create({ jar }));
  try {
    // Initial GET request to establish session
    console.log('Logging in...');
    await client.get('https://www.heise.de/sso/login');

    // POST request with credentials
    console.log('Fetching login page...');
    const response = await client.post(
      'https://www.heise.de/sso/login/login',
      new URLSearchParams({
        forward: '',
        username,
        password,
        ajax: '1',
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    // Extract tokens from response
    console.log('Processing login response...');

    // Complete login process
    for (const url of response.data.remote_login_urls) {
      console.log('Logging in to:', url.url, 'with token:', url.data.token);
      await client.post(
        url.url, 
        new URLSearchParams({
          token: url.data.token,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );
    }

    const json = await jar.serialize(); // `jar` is a tough-cookie CookieJar
    fs.writeFileSync(cookieJarPath, JSON.stringify(json));
    console.log('Login successful.');
  } catch (error) {
    console.error('Login failed:', error.message);
    process.exit(1);
  }
}

async function downloadFile(client, url, outputPath, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.get(url, { responseType: 'stream' });
      const statusCode = response.status;

      await mkdirp(path.dirname(outputPath));
      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);
      return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } catch (error) {
      console.warn(`Attempt ${attempt} failed: ${error.message}`);
      if (error.response && error.response.status === 404) {
        console.error(chalk.red(`File not found: ${url}`));
        return 404;
      }
      if (attempt === maxRetries) throw error;
      await new Promise(res => setTimeout(res, 5000)); // Wait before retrying
    }
  }
}

program
  .option('-v, --verbose', 'Enable verbose output')
  .argument('<magazine>', 'Magazine name (e.g., ct, ix)')
  .argument('<startYear>', 'Start year', parseInt)
  .argument('[endYear]', 'End year', parseInt)
  .parse(process.argv);

const options = program.opts();
const [magazine, startYear, endYear = startYear] = program.args;

(async () => {
  // if cookiejar.json does not exist, login
  if (!fs.existsSync('cookiejar.json')) {
    console.log(chalk.red('cookiejar.json not found. Logging in...'));
    await login({
      username: 'name@example.com',
      password: 'nutella123',
      cookieJarPath: 'cookiejar.json',
    });
  }

  // Load cookies from your cookie jar
  const jar = tough.CookieJar.deserializeSync(
    JSON.parse(fs.readFileSync('cookiejar.json', 'utf-8'))
  );
  const client = wrapper(axios.create({ jar }));

  for (let year = startYear; year <= endYear; year++) {
    for (let issue = 1; issue <= 32; issue++) {
      const issueStr = String(issue).padStart(2, '0');
      const basePath = path.join(magazine, String(year), `${magazine}.${year}.${issueStr}`);
      const pdfPath = `${basePath}.pdf`;

      if (fs.existsSync(pdfPath)) {
        if (options.verbose) console.log(chalk.yellow(`Skipping existing issue: ${pdfPath}`));
        continue;
      }

      try {
        // Download thumbnail
        const thumbUrl = `https://heise.cloudimg.io/v7/_www-heise-de_/select/thumbnail/${magazine}/${year}/${issue}.jpg`;
        if (await downloadFile(client, thumbUrl, `${basePath}.jpg`) == 404) {
          break;
        }

        // Fetch article numbers
        const archiveUrl = `https://www.heise.de/select/${magazine}/archiv/${year}/${issue}/download`;
        await downloadFile(client, archiveUrl, pdfPath);

        console.log(chalk.green(`Downloaded issue: ${pdfPath}`));
      } catch (error) {
        console.error(chalk.red(`Failed to process issue ${year}/${issueStr}: ${error.message}`));
      }
    }
  }
})();
