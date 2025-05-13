import axios from 'axios';
import tough from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import fs from 'fs';
import path from 'path';
import { mkdirp } from 'mkdirp';
import puppeteer from 'puppeteer';


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
      await mkdirp(path.dirname(outputPath));
      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);
      return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } catch (error) {
      console.warn(`Attempt ${attempt} failed: ${error.message}`);
      if (attempt === maxRetries) throw error;
      await new Promise(res => setTimeout(res, 5000)); // Wait before retrying
    }
  }
}


export async function downloadPageAsPDF(jar, url, outputPath) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  // Get cookies for the domain
  const cookies = await new Promise((resolve, reject) => {
    jar.getCookies(url, { allPaths: true }, (err, cookies) => {
      if (err) reject(err);
      else resolve(cookies);
    });
  });

  // Convert to Puppeteer format
  const puppeteerCookies = cookies.map((c) => ({
    name: c.key,
    value: c.value,
    domain: c.domain.startsWith('.') ? c.domain.slice(1) : c.domain,
    path: c.path,
    expires: c.expires instanceof Date ? Math.floor(c.expires.getTime() / 1000) : -1,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite === 'strict' ? 'Strict' :
              c.sameSite === 'lax' ? 'Lax' :
              'None',
  }));

  // Set cookies in Puppeteer
  await page.setCookie(...puppeteerCookies);

  // Navigate to page
  await page.goto(url, { waitUntil: 'networkidle0' });

  // Save PDF
  await mkdirp(path.dirname(outputPath));
  await page.pdf({ path: outputPath, format: 'A4' });

  await browser.close();
}



import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
export async function mergePDFs(inputPaths, outputPath) {
  const args = [
    '-dBATCH',
    '-dNOPAUSE',
    '-q',
    '-sDEVICE=pdfwrite',
    `-sOutputFile=${outputPath}`,
    ...inputPaths
  ];

  try {
    await execFileAsync('gs', args);
    console.log(`Merged PDF saved to ${outputPath}`);
  } catch (err) {
    console.error('Ghostscript merge failed:', err);
    throw err;
  }
}



import { program } from 'commander';
import chalk from 'chalk';

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
        await downloadFile(client, thumbUrl, `${basePath}.jpg`);

        // Fetch article numbers
        const archiveUrl = `https://www.heise.de/select/${magazine}/archiv/${year}/${issue}`;
        const archiveResponse = await client.get(archiveUrl);


        
        const articleMatches = archiveResponse.data.match(/\/select\/.*?\/seite-(\d+)\"/g) || [];
        const articleNumbers = [...new Set(articleMatches.map(match => match.match(/seite-(\d+)/)[1]))];

        const articlePaths = [];

        for (const article of articleNumbers) {
          const articlePath = path.join(magazine, String(year), issueStr, `${magazine}.${year}.${issueStr}.${article}.pdf`);
          const articleSlug = `select/${magazine}/archiv/${year}/${issue}/seite-${article}`;
          const articleUrl = `https://www.heise.de/${articleSlug}`;
          const articleUrlPDF = `https://www.heise.de/${articleSlug}/pdf`;

          // Check if the article is available as a PDF
          // if (archiveResponse.data.includes(`${articleSlug}/pdf`)) {
          //   console.log(chalk.blue(`Article seite-${article} is available as PDF`));
          //   await downloadFile(client, articleUrlPDF, articlePath);
          // } else {
            console.log(chalk.red(`Article seite-${article} is not available as PDF`));
            await downloadPageAsPDF(
              jar,
              `${articleUrl}?view=print`,
              articlePath,
            );
          // }
          articlePaths.push(articlePath);
        }

        // Merge articles into single PDF
        await mergePDFs(articlePaths, pdfPath);

        // Clean up individual article PDFs
        articlePaths.forEach(file => fs.unlinkSync(file));
        fs.rmdirSync(path.dirname(articlePaths[0]));

        console.log(chalk.green(`Downloaded and merged issue: ${pdfPath}`));
      } catch (error) {
        console.error(chalk.red(`Failed to process issue ${year}/${issueStr}: ${error.message}`));
      }
    }
  }
})();
