const { Client, LocalAuth } = require('whatsapp-web.js');
const FormData = require('form-data');
const axios = require('axios');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const readXlsxFile = require('read-excel-file/node');
const path = require('path');
const puppeteer = require('puppeteer-core');
const cheerio = require('cheerio');
const XLSX = require('xlsx');

const client = new Client({ authStrategy: new LocalAuth() });
const userSessions = new Map();
let cachedSessionCookies = null;
let userDataCache = null;
let partnerMappings = null;
const userDataCacheByFile = {};
const COOKIE_TTL = 297000;        // 4:57 min
const REFRESH_THRESHOLD = 285000; // 4:45 min
let lastAuthTime = 0;
let refreshingPromise = null;
let autoRefreshTimeout = null;
let partnerIndex = null;

const toTitleCase = (str) => {
    if (!str) return '';
    return str.trim()
              .split(/\s+/)
              .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
              .join(' ');
};

const normalize = (str) => str?.toString().trim().toLowerCase() || '';

const createHeaderMap = (header) => header.reduce((acc, col, index) => {
    acc[col] = index;
    return acc;
}, {});



const loadAllData = async () => {
    try {
        await Promise.all([
            loadUserDataFromExcel(),
            loadExcelData(),
            loadPartnerMappings()
        ]);
    } catch (err) {
        console.error('Error loading data:', err.message);
    }
};


const loadUserDataFromExcel = async (filename = 'PortalUsers.xlsx') => {
    if (userDataCacheByFile[filename]) return userDataCacheByFile[filename];

    try {
        const filePath = path.resolve(__dirname, filename);
        const rows = await readXlsxFile(filePath);
        if (!rows || rows.length < 2) return new Map();

        const [header, ...data] = rows;
        const headerMap = createHeaderMap(header);


        const idxUsername = headerMap['Username'];
        const idxName = headerMap['Name'];
        const idxMobileNo = headerMap['MobileNo'];
        const idxSubscriberId = headerMap['SubscriberId'];
        const idxEmail = headerMap['Email'];

        const userDataCache = new Map();

        for (let i = 0, len = data.length; i < len; i++) {
            const row = data[i];
            const username = normalize(row[idxUsername]);
            const name = normalize(row[idxName]);
            const mobileNo = normalize(row[idxMobileNo]);
            const subscriberId = normalize(row[idxSubscriberId]);
            const email = normalize(row[idxEmail]);

            const userData = {
                MobileNo: mobileNo,
                Username: username,
                SubscriberId: subscriberId,
                Name: name,
                Email: email
            };

            if (username) userDataCache.set(username, userData);
            if (subscriberId) userDataCache.set(subscriberId, userData);
        }

        userDataCacheByFile[filename] = userDataCache;
        return userDataCache;
    } catch (err) {
        console.error(`Error loading user data from Excel: ${err.message}`);
        return new Map();
    }
};

const loadPartnerMappings = (filename = 'TicketMappingANP.xlsx') => {
    if (partnerMappings) return partnerMappings;

    try {
        const workbook = XLSX.readFile(path.join(__dirname, filename));
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        
        partnerMappings = {};
        
        for (const row of rows) {
            const jhCode = row['JH Code']?.trim();
            const partnerId = row['Partner ID']?.toString().trim();
            
            if (jhCode && partnerId) {
                partnerMappings[jhCode] = {
                    partnerId: partnerId,
                    partnerName: row['Partner Name']?.trim() || 'Unknown'
                };
            }
        }
        return partnerMappings;
    } catch (err) {
        console.error(`Error reading partner mappings: ${err.message}`);
        return {};
    }
};

const loadExcelData = () => {
    if (jhCodeMap) return;

    try {
        const workbook = XLSX.readFile(path.join(__dirname, 'CAFMappingANP.xlsx'));
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);
        
        jhCodeMap = new Map();
        partnerIndex = new Map();
        
        for (const row of data) {
            const partner = normalize(row['Associated Partner']);
            const jhCode = row['JH Code'];
            
            if (partner && jhCode) {
                jhCodeMap.set(partner, jhCode);
                
                const words = partner.split(' ');
                for (const word of words) {
                    if (word.length > 2) {
                        if (!partnerIndex.has(word)) {
                            partnerIndex.set(word, new Set());
                        }
                        partnerIndex.get(word).add(partner);
                    }
                }
            }
        }
    } catch (err) {
        console.error(`Error reading Excel file: ${err.message}`);
    }
};

const scheduleAutoRefresh = () => {
  if (autoRefreshTimeout) clearTimeout(autoRefreshTimeout);
  const timeSinceAuth = Date.now() - lastAuthTime;
  const delay = Math.max(REFRESH_THRESHOLD - timeSinceAuth, 0);

  autoRefreshTimeout = setTimeout(() => {
    if (!refreshingPromise) {
      refreshingPromise = refreshCookies();
    }
  }, delay);
};

const refreshCookies = async () => {
    try {
        const { railwireCookie, ciSessionCookie } = await authenticate('support', 'Touch5SP');
        cachedSessionCookies = { railwireCookie, ciSessionCookie };
        lastAuthTime = Date.now();
        scheduleAutoRefresh();
        return cachedSessionCookies;
    } catch (err) {
        console.error('Cookie refresh failed:', err.message);
        return null;
    } finally {
        refreshingPromise = null;
    }
};


const getCookies = async () => {
    const now = Date.now();
    const age = now - lastAuthTime;

    if (cachedSessionCookies && age < COOKIE_TTL) {
        return cachedSessionCookies;
    }

    if (!refreshingPromise) {
        refreshingPromise = refreshCookies().catch(err => {
            console.error('Error during refreshCookies():', err.message);
            return null;
        });
    }

    return refreshingPromise;
};



const baseURL = 'https://jh.railwire.co.in';
const mainURL = `${baseURL}/billcntl/kycpending`;
let jhCodeMap = null;

const generateQRCode = (qr) => {
    console.log('Scan the QR code below to login:');
    qrcode.generate(qr, { small: true });
};

const launchBrowser = async () => {
    return puppeteer.launch({
        headless: "new",
        executablePath: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-gpu', '--no-zygote', '--disable-extensions',
            '--window-size=512,800', '--window-position=100,100', '--no-sandbox', 
            '--disable-software-rasterizer', '--disable-features=Translate,BackForwardCache,InterestCohort',
            '--mute-audio', '--disable-background-timer-throttling', 
            '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
            '--no-first-run', '--disable-infobars'],
        ignoreDefaultArgs: ['--enable-automation'],
        defaultViewport: null
    });
};


const authenticate = async (username, password) => {
    return retryOperation(async () => {
        let browser;
        try {
            browser = await launchBrowser();
            const page = await browser.newPage();

            // Navigate to login page
            await page.goto('https://jh.railwire.co.in/rlogin ', {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            });

            // Wait for login box with timeout
            await page.waitForSelector('#login-box', { timeout: 15000 });

            // Solve CAPTCHA
            const captchaText = await solveCaptcha(page);
            if (!captchaText) {
                throw new Error('Failed to solve CAPTCHA');
            }

            // Set input fields using evaluate for faster performance
            await page.evaluate((user, pass, captcha) => {
                const usernameInput = document.querySelector('#username');
                const passwordInput = document.querySelector('#password');
                const captchaInput = document.querySelector('#code');

                usernameInput.value = user;
                passwordInput.value = pass;
                captchaInput.value = captcha;

                // Dispatch input and change events to trigger validation
                ['input', 'change'].forEach(eventType => {
                    const event = new Event(eventType, { bubbles: true });
                    usernameInput.dispatchEvent(event);
                    passwordInput.dispatchEvent(event);
                    captchaInput.dispatchEvent(event);
                });
            }, username, password, captchaText);

            // Click login button and wait for navigation
            await Promise.all([
                page.waitForNavigation({
                    waitUntil: 'domcontentloaded',
                    timeout: 60000,
                }),
                page.click('#btn_rlogin'),
            ]);

            const currentUrl = page.url();
            if (!currentUrl.includes('billcntl') && !currentUrl.includes('subcntl')) {
                throw new Error('Login failed. Unexpected URL after navigation.');
            }

      //      console.log('Login successful!');

            // Extract required cookies
            const cookies = await page.cookies();
            const railwireCookie = cookies.find(cookie => cookie.name === 'railwire_cookie_name');
            const ciSessionCookie = cookies.find(cookie => cookie.name === 'ci_session');

            if (!railwireCookie || !ciSessionCookie) {
                throw new Error('Required cookies not found after login.');
            }

            return { railwireCookie, ciSessionCookie };
        } finally {
            if (browser) await browser.close();
        }
    });
};

async function retryOperation(operation, maxRetries = 3, delay = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt === maxRetries) throw error;
            await new Promise(resolve => setTimeout(resolve, delay * attempt));
        }
    }
}


async function fetchUserDataFromPortal(userCode) {
  const cookies = await getCookies();

  const cookieString = `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`;
  const payload = new URLSearchParams({
    'railwire_test_name': cookies.railwireCookie.value,
    'user-search': userCode
  });

  const searchResponse = await axios.post(
    'https://jh.railwire.co.in/billcntl/searchsub ',
    payload.toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieString,
      },
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400,
    }
  );

  let finalUrl = searchResponse.headers.location;
  if (!finalUrl.startsWith('http')) {
    finalUrl = `https://jh.railwire.co.in${finalUrl}`;
  }

  const tableResponse = await axios.get(finalUrl, {
    headers: { Cookie: cookieString }
  });

  const $ = cheerio.load(tableResponse.data);
  const row = $('table.table-striped tbody tr').first();
  if (!row.length) return null;

  const cells = row.find('td');
  if (cells.length < 6) return null;

  const usernameAnchor = cells.eq(1).find('a');
  const userDetailHref = usernameAnchor.attr('href');
  const userDetailUrl = `https://jh.railwire.co.in${userDetailHref}`;

  let name = '';
  try {
    const detailResponse = await axios.get(userDetailUrl, {
      headers: { Cookie: cookieString }
    });

    const $$ = cheerio.load(detailResponse.data);
    $$('.table-bordered.table-condensed.table-striped tr').each((_, tr) => {
      const key = $$(tr).find('td').first().text().trim();
      if (key === 'Name') {
        name = $$(tr).find('td').eq(1).text().trim();
      }
    });
  } catch (err) {
    console.error('Failed to fetch user detail page:', err.message);
  }

  const userData = {
    username: usernameAnchor.text().trim(),
    mobileNo: cells.eq(5).text().trim(),
    id: cells.eq(0).text().trim(),
    name: name
  };

  return userData ? {
    Username: userData.username,
    MobileNo: userData.mobileNo,
    SubscriberId: userData.id,
    Name: userData.name
  } : null;
}

// Solve Captcha
async function solveCaptcha(page) {
    const element = await page.$('#captcha_code');
    if (!element) return null;

    const buffer = await element.screenshot();
    const { data: { text } } = await Tesseract.recognize(buffer, 'eng', {
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    });

    return text.replace(/[^A-Z0-9]/g, '');
}


const resetSession = async (userData, cookies) => {
    const payload = `uname=${userData.Username}&railwire_test_name=${cookies.railwireCookie.value}`;
    const config = {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Cookie': `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`
        }
    };
    try {
        const [res1, res2] = await Promise.all([
            axios.post('https://jh.railwire.co.in/billcntl/endacctsession', payload, config),
            axios.post('https://jh.railwire.co.in/billcntl/clear_acctsession', payload, config)
        ]);
        
        console.log(`Main: ${res1.data.STATUS} | Secondary: ${res2.data.STATUS}`);
        
        return res1.data.STATUS === 'OK' && res2.data.STATUS === 'OK';
    } catch (error) {
        console.error('Reset error:', error.message);
        return false;
    }
};

const DeactivateID = async (userData, cookies) => {
    const payload = `subid=${userData.SubscriberId}&railwire_test_name=${cookies.railwireCookie.value}`;
    const config = {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Cookie': `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`
        }
    };

    try {
        const response = await axios.post('https://jh.railwire.co.in/billcntl/update_expiry', payload, config);
        
        console.log(`ID status: ${response.data.STATUS}`);
        return response.data.STATUS === 'OK';
    } catch (error) {
        console.error('Deactivate error:', error.message);
        return false;
    }
};

const resetPassword = async (userData, cookies) => {
    const config = {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Cookie': `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`
        }
    };

    const basePayload = `subid=${userData.SubscriberId}&mobileno=${userData.MobileNo}&railwire_test_name=${cookies.railwireCookie.value}`;

    try {
        const [portalRes, pppoeRes] = await Promise.all([
            axios.post('https://jh.railwire.co.in/subapis/subpassreset', `${basePayload}&flag=Bill`, config),
            axios.post('https://jh.railwire.co.in/subapis/subpassreset', `${basePayload}&flag=Internet`, config)
        ]);
        
        console.log(`Portal: ${portalRes.data.STATUS} | PPPoE: ${pppoeRes.data.STATUS}`);
        return { 
            portalReset: portalRes.data.STATUS === 'OK', 
            pppoeReset: pppoeRes.data.STATUS === 'OK' 
        };
    } catch (error) {
        console.error('Password reset error:', error.message);
        return { portalReset: false, pppoeReset: false };
    }
};


const getUserIdentifier = (message) => {
    return message.fromMe ? message.to : (message.author || message.from);
};

const waitForReply = async (originalMessage) => {
    const userIdentifier = getUserIdentifier(originalMessage);
    return new Promise((resolve) => {
        const listener = (message) => {
            if (getUserIdentifier(message) === userIdentifier) {
                client.removeListener('message', listener);
                resolve(message);
            }
        };
        client.on('message', listener);
    });
};

const handlePlanChange = async (message) => {
    const chat = await message.getChat();
    const cookies = await getCookies();
    
    await chat.sendMessage("Username:");
    const usernameMessage = await waitForReply(message);
    const usernameToSearch = usernameMessage.body.trim();
    if (!usernameToSearch) return await chat.sendMessage("Username cannot be empty.");

    await chat.sendMessage("Package ID:");
    const pkgIdMessage = await waitForReply(message);
    const desiredPkgId = pkgIdMessage.body.trim();
    if (!desiredPkgId) return await chat.sendMessage("Package ID cannot be empty.");
    
    const cookieString = `${cookies.railwireCookie.name}=${cookies.railwireCookie.value}; ${cookies.ciSessionCookie.name}=${cookies.ciSessionCookie.value}`;

    const payload = new URLSearchParams({
        'railwire_test_name': cookies.railwireCookie.value,
        'user-search': usernameToSearch
    });

    const searchResponse = await axios.post(
        'https://jh.railwire.co.in/billcntl/searchsub ',
        payload.toString(),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': cookieString,
            },
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400
        }
    );

    const redirectUrl = searchResponse.headers.location;
    const finalUrl = redirectUrl.startsWith('http')
        ? redirectUrl
        : `https://jh.railwire.co.in${redirectUrl}`;

    const tableResponse = await axios.get(finalUrl, {
        headers: {
            'Cookie': cookieString,
        }
    });

    const $ = cheerio.load(tableResponse.data);
    
    const users = [];
    $('table.table-striped tbody tr').each(function() {
        const row = $(this);
        const id = row.find('td:nth-child(1)').text().trim();
        const usernameCell = row.find('td:nth-child(2)');
        const username = usernameCell.find('a').text().trim();
        const lastLogin = row.find('td:nth-child(4)').text().trim();
        const nextRenewal = row.find('td:nth-child(5)').text().trim();
        const mobile = row.find('td:nth-child(6)').text().trim();
        const link = usernameCell.find('a').attr('href');
        
        if (username && link) {
            users.push({
                id,
                username,
                lastLogin,
                nextRenewal,
                mobile,
                link
            });
        }
    });

    if (users.length === 0) {
        await chat.sendMessage(`❌ No users found matching "${usernameToSearch}"`);
        return;
    }

    let selectedUser = null;

    // Multiple users found, check for exact match first
    const exactMatch = users.find(user => user.username.toLowerCase() === usernameToSearch.toLowerCase());
    
    if (exactMatch) {
        selectedUser = exactMatch;
        await chat.sendMessage(`ID: ${selectedUser.id}\nExact match: ${selectedUser.username}\nProceeding Change..`);
    } else {
        // Show all options and let user select
        let optionsMessage = `Found ${users.length} users matching "${usernameToSearch}":\n\n`;
        
        users.forEach((user, index) => {
            const status = user.lastLogin.includes('No login') ? 'Inactive' : 'Active';
            const renewalStatus = user.nextRenewal && new Date(user.nextRenewal) < new Date() ? 'Expired' : '';
            
            optionsMessage += `${index + 1}. ${status} *${user.username}* (ID: ${user.id})\n`;
            optionsMessage += `Mobile: ${user.mobile}\n`;
            optionsMessage += `Renewal: ${user.nextRenewal} ${renewalStatus}\n`;
            optionsMessage += `Last Login: ${user.lastLogin}\n\n`;
        });
        
        optionsMessage += `Please reply with the no. (1-${users.length}) to select:`;
        await chat.sendMessage(optionsMessage);
        
        const selectionMessage = await waitForReply(message);
        const selection = parseInt(selectionMessage.body.trim());
        
        if (isNaN(selection) || selection < 1 || selection > users.length) {
            await chat.sendMessage("❌ Invalid selection.");
            return;
        }
        
        selectedUser = users[selection - 1];
    }

    // Proceed with the selected user
    const detailUrl = `https://jh.railwire.co.in${selectedUser.link}`;
    const detailPage = await axios.get(detailUrl, {
        headers: {
            'Cookie': cookieString,
        }
    });

    const $$ = cheerio.load(detailPage.data);
    const formData = {
        subid: $$('#subid').val() || '',
        status: $$('#status').val() || '',
        oldpkgid: $$('#oldpackageid').val() || '',
        verifyHidden: $$('#verifyHidden').val() || '',
        pkgid: desiredPkgId
    };

    const planChanged = await ChangePlan(formData, selectedUser.username, cookies);

    if (planChanged) {
        await chat.sendMessage(`✅ Plan changed successfully\n\nID: ${selectedUser.username}!\nNew Package ID: ${desiredPkgId}`);
    } else {
        await chat.sendMessage(`❌ Failed to change plan for ${selectedUser.username}. Check package ID and try again.`);
    }
};

async function login() {
  try {
    const response = await axios.post('http://apiv1.inteligo.tech/api/OTT/GSignin', {
      UserName: 'JH-MSP',
      Platform: 'GPanel',
      Password: 'WfGMAkmJtRundSrD7r/MQA==',
      IPAddress: ''
    });

    return response.data; // Should contain UserId
  } catch (error) {
    console.error('Login failed:', error.message);
    throw error;
  }
}


const checkComplaintStatus = async (message) => {
    const chat = await message.getChat();

    // Step 1: Ask for Complaint Number
    await chat.sendMessage("🔢 Complaint No:");
    const compNoMsg = await waitForReply(message);
    const complaintNumber = parseInt(compNoMsg.body.trim());

    if (isNaN(complaintNumber)) {
        await chat.sendMessage("❌ Invalid Complaint Number.");
        return;
    }

    // Step 2: Login to get UserId
    let loginResult;
    try {
        loginResult = await login();
    } catch (err) {
        await chat.sendMessage("❌ Failed to authenticate with backend.");
        return;
    }

    // Step 3: Fetch all complaints
    try {
        const complaintsResponse = await axios.post(
            `http://apiv1.inteligo.tech/api/OTT/GGetOTTComplaintList?UserID=${loginResult.UserId}`,
            loginResult.UserId
        );

        const complaints = complaintsResponse.data;

        // Step 4: Find the complaint
        const complaint = complaints.find(c => c.ComplaintNumber === complaintNumber);

        if (!complaint) {
            await chat.sendMessage(`❌ No complaint found with number ${complaintNumber}`);
            return;
        }

        // Step 5: Format and send response in your desired format
        const statusMap = {
            'Closed': '✅',
            'OnHold': '⏸️',
            'Open': '🔄'
        };

        const statusEmoji = statusMap[complaint.Status] || 'ℹ️';
        const remark = complaint.Remark ? complaint.Remark : "No remarks provided.";

        let reply = "*Complaint Status*\n\n";
        reply += `*Complaint Number:* ${complaint.ComplaintNumber}\n`;
        reply += `*Username:* ${complaint.Username}\n`;
        reply += `*Status:* ${statusEmoji} ${complaint.Status}\n`;
        reply += `*Service:* ${complaint.ServiceProvider}\n\n`;
        reply += `*Remark:* ${remark}`;

        await chat.sendMessage(reply);

    } catch (error) {
        await chat.sendMessage(`❌ Error fetching complaint.\n\nError: ${error.message}`);
    }
};

// New function to handle OTT complaints automatically
const processOTTComplaint = async (message, userIdentifier) => {
    const { userCode } = userSessions.get(userIdentifier);
    const chat = await message.getChat();
    
    // Load OTT data
    const ottData = await loadUserDataFromExcel();
    const userData = ottData.get(userCode);

    if (!userData) {
        userSessions.delete(userIdentifier);
        return;
    }

    // Automatically use Hotstar_Super as the service provider
    const serviceProvider = 'Hotstar_Super';

    try {
        // Login to get UserId
        const loginResult = await login();
        
        const payload = {
            Mode: 1,
            ComplaintNo: 0,
            ContactName: userData.ContactName,
            CustMobileNo: userData.MobileNo,
            Username: userData.Username,
            CompanyName: "RailTel Corporation India Ltd.",
            VendorCode: "RTCIL",
            OperatorCode: "JHRT",
            Email: userData.Email,
            Phone: userData.MobileNo,
            Subject: `${serviceProvider} not working`,
            Description: `Customer is not able to use ${serviceProvider}`,
            Remark: "",
            Status: "O",
            TicketOwner: "Angad",
            ServiceProvider: serviceProvider,
            IssueType: "Subscription",
            ReportedDate: new Date().toISOString().slice(0, 16),
            Priority: "High",
            Channel: "Phone",
            Classifications: "Problem",
            UserId: loginResult.UserId
        };

        // Submit complaint
        const response = await axios.post(
            'http://apiv1.inteligo.tech/api/OTT/GOTTComplaintRegistration',
            payload
        );

        const result = response.data;

        // Fetch updated complaint list to get latest complaint
        const complaintsResponse = await axios.post(
            `http://apiv1.inteligo.tech/api/OTT/GGetOTTComplaintList?UserID=${loginResult.UserId}`,
            loginResult.UserId
        );

        const complaints = complaintsResponse.data;
        const latestComplaint = complaints.length > 0 ? complaints[0] : null;

        // Build reply
        const apiMessage = result.ErrorMsg || "Unknown response from server.";
        let reply = `*${apiMessage}*\n\n`;
        reply += `*Username:* ${userData.Username}\n`;

        if (latestComplaint) {
            reply += `*Complaint No.:* ${latestComplaint.ComplaintNumber}\n`;
            reply += `*Status:* ${latestComplaint.Status}\n`;
        }

        reply += "\n*Please ask the customer to answer the call from the OTT team*.";

        await chat.sendMessage(reply);

    } catch (error) {
        await chat.sendMessage(`❌ Error submitting complaint for ${userCode}.\n\nError: ${error.message}`);
    }

    userSessions.delete(userIdentifier);
};

// Subjects list (already present in your file, keep it as global)
const subjects = [
  "Activate with available balance", "AGNP bank details updation", "ANP - Mobile number and Email ID change",
  "ANP address change", "ANP Demo ID renewal", "ANP disbursement issue", "ANP GSTIN issue",
  "ANP name change", "ANP online recharge issue", "ANP-AGNP mapping", "Authentication issue",
  "BSS issue", "CRM ticket issue", "CSV download option issue", "Data usage issue", "Decommission date updation",
  "disable sub-online recharge", "DOC updation", "Double recharge", "DVR IP Port Request",
  "Enable sub-online recharge", "IFSC code issue", "Invoice issue", "Location transfer",
  "Others", "Package change", "Permanent Inactive Request", "Plan Implementation", "Plan Upgradation",
  "SLA dashboard issue", "Stale session", "Static IP DoP updation", "Static IP recharge issue",
  "Static IP renewal issue", "Sub - Mobile number and Email ID Change", "Subscriber address change",
  "Subscriber applicant name change", "Subscriber GSTIN change", "Subscriber GSTIN issue",
  "Subscriber GSTIN Removal", "Subscriber KYC-Application Mapping", "Subscriber KYC/Application issue",
  "Subscriber online recharge issue", "Subscriber package issue", "Subscriber static IP issue",
  "Subscription expiry", "Subscription type change", "User Reactivation", "Username change",
  "Wrong recharge"
];


// Main SLA Ticket Creation Function
const createSLATicket = async (message) => {
    const chat = await message.getChat();

    try {
        // Step 1: Login
        const loginResponse = await axios.post(
            'https://sla.railwire.co.in/rlogin/index ',
            new URLSearchParams({
                username: 'MSP-JH',
                password: 'Wired&Wireless',
            }),
            {
                maxRedirects: 0,
                validateStatus: status => status === 303,
            }
        );

        const setCookieHeader = loginResponse.headers['set-cookie'];
        if (!setCookieHeader || setCookieHeader.length === 0) {
            throw new Error('Login failed: No session cookie received');
        }

        const ciSessionCookie = setCookieHeader
            .find(cookie => cookie.startsWith('ci_session='))
            .split(';')[0];

        // Step 2: Show subject list
        let subjectListMsg = "Subject:\n";
        subjects.forEach((subj, i) => {
            subjectListMsg += `${i + 1}. ${subj}\n`;
        });
        await chat.sendMessage(subjectListMsg);

        // Step 3: Wait for subject selection
        const subjectMessage = await waitForReply(message);
        const subjectIndex = parseInt(subjectMessage.body.trim());
        const selectedSubject = subjects[subjectIndex - 1];

        if (!selectedSubject) {
            await chat.sendMessage("❌ Invalid subject selection.");
            return;
        }

        // Step 4: Ask for description (single message input)
        await chat.sendMessage("Enter description:");
        const descMessage = await waitForReply(message);
        const desc = descMessage.body.trim(); // Accepts multiline input

        // Step 5: Confirm sending without preview
        await chat.sendMessage("✅ Do you want to send the request? Type *yes* or *no*.");

        const confirmMessage = await waitForReply(message);
        if (confirmMessage.body.trim().toLowerCase() !== 'yes') {
            await chat.sendMessage("🚫 Request canceled.");
            return;
        }

        // Step 6: Submit form
        const form = new FormData();
        form.append('desc', desc);
        form.append('subject', selectedSubject);
        form.append('project', 'Retail');
        form.append('scode', 'JH');
        form.append('mspid', '11');
        form.append('circle', 'JH');
        form.append('assig_date', 'undefined');

        await axios.post(
            'https://sla.railwire.co.in/mspcntl/addmspincident ',
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    Cookie: ciSessionCookie,
                }
            }
        );

        // Step 7: Fetch latest incident
        const qs = require('qs');
        const ajaxPayload = qs.stringify({
            draw: 1,
            start: 0,
            length: 1,
            incident_status: 'Pending',
            descp: '',
            s_date: '',
            'search[value]': '',
            'search[regex]': false,
            ...Array.from({ length: 7 }).reduce((acc, _, i) => ({
                ...acc,
                [`columns[${i}][data]`]: ['ticketid', 'msp_created', 'etr', 'status', 'ptype', 'actualclosedate', 'description'][i],
                [`columns[${i}][searchable]`]: true,
                [`columns[${i}][orderable]`]: false,
                [`columns[${i}][search][value]`]: '',
                [`columns[${i}][search][regex]`]: false
            }), {})
        });

        const ajaxResponse = await axios.post(
            'https://sla.railwire.co.in/mspcntl/msp_incident_details_ajax ',
            ajaxPayload,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'Cookie': ciSessionCookie
                }
            }
        );

        const incidents = ajaxResponse.data?.data;
        if (incidents && incidents.length > 0) {
            const ticketId = incidents[0].ticketid;
            await chat.sendMessage(`✅ Incident created successfully! Ticket ID: #${ticketId}`);
        } else {
            await chat.sendMessage("⚠️ Incident submitted but no ticket ID found.");
        }

    } catch (error) {
        console.error('Error creating SLA ticket:', error.message);
        await chat.sendMessage("❌ Failed to create SLA ticket.");
    }
};


/*
const handleTicketActivation = async (message) => {
  const chat = await message.getChat();
  await chat.sendMessage("*++* Working *++*");

  try {
    // Step 1: Get cookies
    const cookies = await getCookies();
    if (!cookies) {
      await chat.sendMessage("Authentication failed. Try again later.");
      return;
    }

    const createClient = (cookies) => axios.create({
      baseURL: 'https://jh.railwire.co.in',
      headers: {
        'Cookie': `ci_session=${cookies.ciSessionCookie.value}; ${cookies.railwireCookie.name}=${cookies.railwireCookie.value}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      withCredentials: true,
    });

    const client = createClient(cookies);
    const pageOffsets = ['', '30', '60'];
    const tickets = [];

    // Step 2: Fetch tickets from pages
    for (const offset of pageOffsets) {
      const url = `/crmcntl/bill_tickets${offset ? '/' + offset : ''}`;
      const response = await client.get(url);
      const $ = cheerio.load(response.data);

      $('table#results tbody tr').each((i, row) => {
        const cells = $(row).find('td');
        const respondLink = $(cells[cells.length - 1]).find('a').attr('href');
        const statusText = $(cells[7]).text().trim().toLowerCase();
        const subjectText = $(cells[4]).text().trim();
        const match = respondLink?.match(/\/billticketview\/(\d+)\//);
        if (match) {
          tickets.push({
            ticketId: match[1],
            viewUrl: respondLink,
            status: statusText,
            subject: subjectText.toLowerCase(),
          });
        }
      });
    }

    if (tickets.length === 0) {
      await chat.sendMessage("No tickets found.");
      return;
    }

    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;
    let closedCount = 0;
    const processedTickets = [];

    // Step 3: Process each ticket
    for (const ticket of tickets) {
      if (!['open', 'progress'].includes(ticket.status)) {
        skippedCount++;
        continue;
      }

      // Step 3.1: Get subscriber ID from ticket details
      const detailRes = await client.get(ticket.viewUrl);
      const $$ = cheerio.load(detailRes.data);
      let subscriberId = null;

      $$('table.table-bordered.table-striped.table-condensed tbody tr').each((i, row) => {
        const label = $$(row).find('td:first-child').text().trim().toLowerCase();
        const value = $$(row).find('td:nth-child(2)').text().trim();
        if (label === 'subscriber') {
          subscriberId = value;
        }
      });

      ticket.subscriberId = subscriberId || 'N/A';

      const autoCloseSubjects = ['no connectivity', 'wireless network issue'];
      const shouldCheckSession = autoCloseSubjects.some(subject =>
        ticket.subject.includes(subject)
      );

      if (shouldCheckSession && subscriberId) {
        try {
          const sessionStatus = await checkSessionStatus(client, cookies, subscriberId);
          if (sessionStatus === 'Active') {
            const closePayload = new URLSearchParams({
              ticketid: ticket.ticketId,
              response: 'The Link has been restored ✅',
              railwire_test_name: cookies.railwireCookie.value,
            });

            const closeResponse = await client.post('/crmcntl/close_ticket', closePayload.toString());

            if (closeResponse.status === 200) {
              closedCount++;
              processedTickets.push({
                ticketId: ticket.ticketId,
                subscriberId: ticket.subscriberId,
                status: 'closed',
                reason: 'Connection restored',
                subject: ticket.subject,
              });
              continue;
            } else {
              console.warn(`Failed to close ticket ${ticket.ticketId}`);
            }
          }
        } catch (err) {
          console.warn(`Session check failed for ticket ${ticket.ticketId}:`, err.message);
        }
      }

      if (ticket.status !== 'open') {
        skippedCount++;
        processedTickets.push({
          ticketId: ticket.ticketId,
          subscriberId: ticket.subscriberId,
          status: 'skipped',
          reason: 'Already in progress.',
          subject: ticket.subject,
        });
        continue;
      }

      const parts = subscriberId?.split('.') || [];
      const jhCode = parts.length >= 2 ? parts.slice(0, 2).join('.') : null;
      const matched = jhCode ? partnerMappings[jhCode] : null;

      if (!matched) {
        failCount++;
        processedTickets.push({
          ticketId: ticket.ticketId,
          subscriberId: ticket.subscriberId,
          status: 'failed',
          reason: 'Manually Review ✨',
          subject: ticket.subject,
        });
        continue;
      }

      try {
        // Step 3.6: Update ticket status from open to progress
        const payload = new URLSearchParams({
          assignedto: matched.partnerId,
          ticketid: ticket.ticketId,
          status: 'progress',
          selected_type: 'LCO',
          railwire_test_name: cookies.railwireCookie.value,
        });

        const response = await client.post('/crmcntl/change_ticketstatus', payload.toString());

        if (response.status === 200) {
          // Step 3.7: Send reply
          const replyForm = new FormData();
          replyForm.append('railwire_test_name', cookies.railwireCookie.value);
          replyForm.append('ticketid', ticket.ticketId);
          replyForm.append('content', 'Dear Customer, your request has been forwarded to the LCO. If unresolved, Contact us at 18001039139.');

          try {
            await client.post('/crmcntl/bill_tickreply', replyForm, {
              headers: replyForm.getHeaders(),
            });
          } catch (err) {
            console.warn(`Reply failed for ticket ${ticket.ticketId}:`, err.message);
          }

          successCount++;
          processedTickets.push({
            ticketId: ticket.ticketId,
            subscriberId: ticket.subscriberId,
            status: 'progress',
            partnerName: matched.partnerName,
            partnerId: matched.partnerId,
            subject: ticket.subject,
            action: 'Assigned to partner',
          });
        } else {
          failCount++;
          processedTickets.push({
            ticketId: ticket.ticketId,
            subscriberId: ticket.subscriberId,
            status: 'failed',
            reason: 'Status update failed',
            subject: ticket.subject,
          });
        }
      } catch (err) {
        failCount++;
        processedTickets.push({
          ticketId: ticket.ticketId,
          subscriberId: ticket.subscriberId,
          status: 'failed',
          reason: `Exception: ${err.message}`,
          subject: ticket.subject,
        });
      }
    }

    // Step 4: Clean and concise summary
    let ticketSummary = "🎯 *Ticket Processing Results*\n\n";
    
    // Group tickets by action type
    const groupedTickets = {
      closed: processedTickets.filter(t => t.status === 'closed'),
      progress: processedTickets.filter(t => t.status === 'progress'),
      failed: processedTickets.filter(t => t.status === 'failed'),
      skipped: processedTickets.filter(t => t.status === 'skipped'),
    };

    ticketSummary += `*📊 Summary:*\n\n`;
    ticketSummary += `✅ ${closedCount} Closed (Session Active)\n`;
    ticketSummary += `🔄 ${successCount} Assigned to Partners\n`;
    ticketSummary += `⏭️ ${groupedTickets.skipped.length} Skipped (In Progress)\n`;
    ticketSummary += `❌ ${failCount} Failed (Manually Check)\n\n`;

    if (groupedTickets.closed.length > 0) {
      ticketSummary += `*🔒 Closed (${groupedTickets.closed.length}):*\n`;
      for (const ticket of groupedTickets.closed) {
        ticketSummary += `#${ticket.ticketId} (${ticket.subscriberId})\n`;
      }
      ticketSummary += `\n`;
    }

    if (groupedTickets.progress.length > 0) {
      ticketSummary += `*🔄 Assigned (${groupedTickets.progress.length}):*\n`;
      for (const ticket of groupedTickets.progress) {
        ticketSummary += `#${ticket.ticketId} -> [${ticket.subscriberId}]\n -> ${ticket.partnerName} \n`;
      }
      ticketSummary += `\n`;
    }

    // Failed tickets - with subscriber info
    if (groupedTickets.failed.length > 0) {
      ticketSummary += `*❌ Failed (${groupedTickets.failed.length}):*\n`;
      for (const ticket of groupedTickets.failed) {
        ticketSummary += `#${ticket.ticketId} -> ${ticket.subscriberId}\n${ticket.reason}\n`;
      }
      ticketSummary += `\n`;
    }
    
    await chat.sendMessage(ticketSummary);

  } catch (error) {
    console.error('Error in handleTicketActivation:', error);
    await chat.sendMessage(`Error processing tickets: ${error.message}`);
  }
};

// Helper function to check session status
async function checkSessionStatus(client, cookies, subscriberCode) {
  try {
    const payload = new URLSearchParams({
      railwire_test_name: cookies.railwireCookie.value,
      'user-search': subscriberCode
    });

    // Step 1: Search subscriber
    const searchRes = await client.post('/billcntl/searchsub', payload.toString());
    const $ = cheerio.load(searchRes.data);
    const detailLink = $('a[href^="/billcntl/subscriptiondetail/"]').attr('href');
    
    if (!detailLink) {
      throw new Error('Subscriber detail link not found');
    }

    // Step 2: Get subscriber detail page
    const detailPageRes = await client.get(detailLink);
    const $$ = cheerio.load(detailPageRes.data);

    // Step 3: Check session status via data usage page
    const dataUsageLink = $$('a[href^="/billcntl/currentmonthdatause/"]').attr('href');
    if (!dataUsageLink) {
      throw new Error('Data usage link not found');
    }

    const usagePageRes = await client.get(dataUsageLink);
    const $$$ = cheerio.load(usagePageRes.data);
    
    // Check if disconnect button exists (indicates active session)
    const sessionActive = $$$('#cusdiscon_btn').length > 0;
    
    return sessionActive ? 'Active' : 'Not Active';
  } catch (err) {
    console.warn(`Session status check failed for ${subscriberCode}:`, err.message);
    return 'Not Active';
  }
}

*/

const handleTicketActivation = async (message) => {
  const chat = await message.getChat();
  await chat.sendMessage("*++* Working *++*");

  try {
    // Step 1: Get cookies
    const cookies = await getCookies();
    if (!cookies) {
      await chat.sendMessage("Authentication failed. Try again later.");
      return;
    }

    const createClient = (cookies) => axios.create({
      baseURL: 'https://jh.railwire.co.in',
      headers: {
        'Cookie': `ci_session=${cookies.ciSessionCookie.value}; ${cookies.railwireCookie.name}=${cookies.railwireCookie.value}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      withCredentials: true,
    });

    const client = createClient(cookies);
    const pageOffsets = ['', '30', '60'];
    const tickets = [];

    // Step 2: Fetch tickets from pages
    for (const offset of pageOffsets) {
      const url = `/crmcntl/bill_tickets${offset ? '/' + offset : ''}`;
      const response = await client.get(url);
      const $ = cheerio.load(response.data);

      $('table#results tbody tr').each((i, row) => {
        const cells = $(row).find('td');
        const respondLink = $(cells[cells.length - 1]).find('a').attr('href');
        const statusText = $(cells[7]).text().trim().toLowerCase();
        const subjectText = $(cells[4]).text().trim();
        const match = respondLink?.match(/\/billticketview\/(\d+)\//);
        if (match) {
          tickets.push({
            ticketId: match[1],
            viewUrl: respondLink,
            status: statusText,
            subject: subjectText.toLowerCase(),
          });
        }
      });
    }

    if (tickets.length === 0) {
      await chat.sendMessage("No tickets found.");
      return;
    }

    let closedCount = 0;
    let skippedCount = 0;
    const processedTickets = [];

    // Step 3: Process each ticket - only handle open/progress with active sessions
    for (const ticket of tickets) {
      // Skip if not open or progress
      if (!['open', 'progress'].includes(ticket.status)) {
        skippedCount++;
        processedTickets.push({
          ticketId: ticket.ticketId,
          status: 'skipped',
          reason: 'Not open/progress status',
          subject: ticket.subject,
        });
        continue;
      }

      // Get subscriber ID from ticket details
      const detailRes = await client.get(ticket.viewUrl);
      const $$ = cheerio.load(detailRes.data);
      let subscriberId = null;

      $$('table.table-bordered.table-striped.table-condensed tbody tr').each((i, row) => {
        const label = $$(row).find('td:first-child').text().trim().toLowerCase();
        const value = $$(row).find('td:nth-child(2)').text().trim();
        if (label === 'subscriber') {
          subscriberId = value;
        }
      });

      ticket.subscriberId = subscriberId || 'N/A';

      // Only check connectivity-related tickets
      const autoCloseSubjects = ['no connectivity', 'wireless network issue'];
      const shouldCheckSession = autoCloseSubjects.some(subject =>
        ticket.subject.includes(subject)
      );

      if (shouldCheckSession && subscriberId) {
        try {
          const sessionStatus = await checkSessionStatus(client, cookies, subscriberId);
          if (sessionStatus === 'Active') {
            // Close the ticket
            const closePayload = new URLSearchParams({
              ticketid: ticket.ticketId,
              response: 'The Link has been restored ✅',
              railwire_test_name: cookies.railwireCookie.value,
            });

            const closeResponse = await client.post('/crmcntl/close_ticket', closePayload.toString());

            if (closeResponse.status === 200) {
              closedCount++;
              processedTickets.push({
                ticketId: ticket.ticketId,
                subscriberId: ticket.subscriberId,
                status: 'closed',
                reason: 'Connection restored',
                subject: ticket.subject,
              });
            } else {
              skippedCount++;
              processedTickets.push({
                ticketId: ticket.ticketId,
                subscriberId: ticket.subscriberId,
                status: 'skipped',
                reason: 'Close request failed',
                subject: ticket.subject,
              });
            }
          } else {
            // Session not active - skip
            skippedCount++;
            processedTickets.push({
              ticketId: ticket.ticketId,
              subscriberId: ticket.subscriberId,
              status: 'skipped',
              reason: 'Session not active',
              subject: ticket.subject,
            });
          }
        } catch (err) {
          skippedCount++;
          processedTickets.push({
            ticketId: ticket.ticketId,
            subscriberId: ticket.subscriberId,
            status: 'skipped',
            reason: `Session check failed: ${err.message}`,
            subject: ticket.subject,
          });
        }
      } else {
        // Not a connectivity ticket or no subscriber ID - skip
        skippedCount++;
        processedTickets.push({
          ticketId: ticket.ticketId,
          subscriberId: ticket.subscriberId,
          status: 'skipped',
          reason: shouldCheckSession ? 'No subscriber ID' : 'Not connectivity issue',
          subject: ticket.subject,
        });
      }
    }

    // Step 4: Simple summary
    let ticketSummary = "🎯 *Ticket Processing Results*\n\n";
    
    ticketSummary += `*📊 Summary:*\n\n`;
    ticketSummary += `✅ ${closedCount} Closed (Session Active)\n`;
    ticketSummary += `⏭️ ${skippedCount} Skipped (Various Reasons)\n\n`;

    const closedTickets = processedTickets.filter(t => t.status === 'closed');

    if (closedTickets.length > 0) {
      ticketSummary += `*🔒 Closed (${closedTickets.length}):*\n`;
      for (const ticket of closedTickets) {
        ticketSummary += `#${ticket.ticketId} (${ticket.subscriberId})\n`;
      }
      ticketSummary += `\n`;
    }
    
    await chat.sendMessage(ticketSummary);

  } catch (error) {
    console.error('Error in handleTicketActivation:', error);
    await chat.sendMessage(`Error processing tickets: ${error.message}`);
  }
};

// Helper function to check session status
async function checkSessionStatus(client, cookies, subscriberCode) {
  try {
    const payload = new URLSearchParams({
      railwire_test_name: cookies.railwireCookie.value,
      'user-search': subscriberCode
    });

    // Step 1: Search subscriber
    const searchRes = await client.post('/billcntl/searchsub', payload.toString());
    const $ = cheerio.load(searchRes.data);
    const detailLink = $('a[href^="/billcntl/subscriptiondetail/"]').attr('href');
    
    if (!detailLink) {
      throw new Error('Subscriber detail link not found');
    }

    // Step 2: Get subscriber detail page
    const detailPageRes = await client.get(detailLink);
    const $$ = cheerio.load(detailPageRes.data);

    // Step 3: Check session status via data usage page
    const dataUsageLink = $$('a[href^="/billcntl/currentmonthdatause/"]').attr('href');
    if (!dataUsageLink) {
      throw new Error('Data usage link not found');
    }

    const usagePageRes = await client.get(dataUsageLink);
    const $$$ = cheerio.load(usagePageRes.data);
    
    // Check if disconnect button exists (indicates active session)
    const sessionActive = $$$('#cusdiscon_btn').length > 0;
    
    return sessionActive ? 'Active' : 'Not Active';
  } catch (err) {
    console.warn(`Session status check failed for ${subscriberCode}:`, err.message);
    return 'Not Active';
  }
}

async function ChangePlan(formData, username, cookies) {
    const url = 'https://jh.railwire.co.in/finapis/msp_plan_applynow';

        const railwireCookie = cookies.railwireCookie;
        const ciSessionCookie = cookies.ciSessionCookie;


    if (!railwireCookie || !ciSessionCookie) {
        throw new Error('Missing required cookies');
    }


    const payload = {
        verifyHidden: formData.verifyHidden,
        subid: formData.subid,
        pkgid: formData.pkgid,
        status: formData.status,
        uname: username,
        oldpkgid: formData.oldpkgid,
        railwire_test_name: railwireCookie.value
    };

    const payloadToSend = new URLSearchParams(payload).toString();
    console.log(payloadToSend);

    try {
        const response = await axios.post(url, payloadToSend, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': `${railwireCookie.name}=${railwireCookie.value}; ${ciSessionCookie.name}=${ciSessionCookie.value}`
            }
        });
		console.log(`Plan changed : "${response.data.STATUS}"`);

        return response.data.STATUS === 'OK';
    } catch (error) {
        console.error('\n❌ Error changing plan:');
        if (error.response) {
            console.error("Status Code:", error.response.status);
            console.error("Response Body:\n", JSON.stringify(error.response.data, null, 2));
        } else {
            console.error("Message:", error.message);
        }
        return false;
    }
}

const processActions = async (message, userIdentifier, wantsSessionReset, wantsPasswordReset, wantsDeactiveID) => {
    const { userCode, userData } = userSessions.get(userIdentifier);
    const cookies = await getCookies();
    const userDataMap = await loadUserDataFromExcel();
    let fetchedUserData = userData || userDataMap.get(userCode);
    
    if (!fetchedUserData) {
        fetchedUserData = await fetchUserDataFromPortal(userCode);
    }
    
    if (fetchedUserData) {
        userSessions.set(userIdentifier, { userCode, userData: fetchedUserData });
        let sessionResetResult = null;
        let passwordResetResult = null;
        let deactivateResult = null;

        if (wantsSessionReset) {
            console.log('Requested Session Cleaning...');
            sessionResetResult = await resetSession(fetchedUserData, cookies);
        }
        if (wantsPasswordReset) {
            console.log('Requested Password Resetting...');
            passwordResetResult = await resetPassword(fetchedUserData, cookies);
        }
        if (wantsDeactiveID) {
            console.log('Activating Deactivated ID...');
            deactivateResult = await DeactivateID(fetchedUserData, cookies);
        }
       
        let responseMessage = `*Name:* ${toTitleCase(fetchedUserData.Name)}\n*ID:* ${userCode}`;
        
        if (wantsSessionReset) {
            responseMessage += '\n' + (sessionResetResult ? '*Session Cleared*, Done ✅' : 'Session not active ❌');
        }
        if (wantsDeactiveID) {
            responseMessage += '\n' + (deactivateResult ? '*Activated*, Done ✅' : 'Failed to active ❌');
        }
        if (wantsPasswordReset) {
            if (passwordResetResult.portalReset && passwordResetResult.pppoeReset) {
                    const firstName = toTitleCase(fetchedUserData.Name).split(' ')[0].toLowerCase();
                    responseMessage += `\n*Default Password:* ${firstName}123`;
                    responseMessage += '\n*Password Reset*, Done ✅';
                  } else {
                console.log('Reset failed due to Server Issue.');
              }
        }
    
        await message.reply(responseMessage);
    } else {
        console.log(`No user data found for JH code or ID: ${userCode}`);
        await message.reply(`Incorrect ID: ${userCode}`);
    }

    userSessions.delete(userIdentifier);
};

const processTasks = async (cookies, originalMessage) => {
    try {
        const { data } = await axios.get(mainURL, { 
            headers: { Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}` },
            timeout: 5000 
        });
        const $ = cheerio.load(data);
        const submittedTasks = [];
        const verifiedTasks = [];

        $('table tbody tr').each((_, el) => {
            const cells = $(el).find('td');
            const status = $(cells[1]).text().trim().toLowerCase();
            const link = $(cells[2]).find('a').attr('href');
            const oltabid = link?.split('/')[3];
            if (status === 'submitted' && link) submittedTasks.push({ link, oltabid });
            else if (status === 'verified' && link) verifiedTasks.push({ link });
        });

        const results = {
            submitted: { total: submittedTasks.length, processed: 0 },
            verified: { total: verifiedTasks.length, processed: 0 }
        };

        for (const { link, oltabid } of submittedTasks) {
            if (await handleSubmittedForm(link, oltabid, cookies, null, originalMessage)) results.submitted.processed++;
        }
        for (const { link } of verifiedTasks) {
            if (await handleVerifiedForm(link, cookies, originalMessage)) results.verified.processed++;
        }

        return results;
    } catch (err) { 
        console.error(`Error processing tasks: ${err.message}`); 
        return null;
    }
};

const processAllForms = async (cookies, originalMessage) => {
    let totalProcessed = 0;
    let isComplete = false;

    while (!isComplete) {
        const results = await processTasks(cookies, originalMessage);
        if (results) {
            totalProcessed += results.submitted.processed + results.verified.processed;
            console.log(`Processed ${results.submitted.processed} Submitted and ${results.verified.processed} Verified Forms.`);

            if (results.submitted.processed === 0 && results.verified.processed === 0) {
                isComplete = true;
            }
        } else {
            console.log('Failed to process KYC tasks. Retrying...');
        }

        if (!isComplete) {
            console.log('Fetching Remaining Application Forms..');
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 5 seconds before refreshing
        }
    }

    return totalProcessed;
};

const getHiddenInputs = async (link, cookies) => {
    try {
        const { data } = await axios.get(`${baseURL}${link}`, { 
            headers: { Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}` },
            timeout: 9000 
        });
        const $ = cheerio.load(data);
        const extract = (name) => $(`input[name=${name}]`).val()?.toLowerCase();
        return {
            firstname: extract('firstname'),
            oltabid: extract('oltabid'),
            pggroupid: extract('pggroupid'),
            pkgid: extract('pkgid'),
            anp: extract('anp'),
            vlanid: $('select#vlanid option:selected').val()?.toLowerCase(),
            caf_type: extract('caf_type'),
            mobileno: extract('mobileno')
        };
    } catch (err) { console.error(`Error extracting inputs from ${link}: ${err.message}`); return {}; }
};

const getUsername = async (firstName, baseUsername, cookies) => {
    const tryDerive = async (modUsername) => {
        try {
            const payload = new URLSearchParams({
                fname: firstName,
                lname: '',
                mod_username: modUsername,
                railwire_test_name: cookies.railwireCookie.value
            }).toString();
            const { data } = await axios.post(`${baseURL}/kycapis/derive_username`, payload, { 
                headers: { 
                    Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 9000 
            });
            return data;
        } catch { return { STATUS: 'ERROR' }; }
    };

    let attempt = 0;
    let response;
    do {
        response = await tryDerive(baseUsername + (attempt || ''));
        attempt++;
    } while (response.STATUS !== 'OK' && attempt < 10);

    return response.UNAME || null;
};

const createSubscription = async (link, derivedUsername, cookies, originalMessage) => {
    try {
        const hiddenInputs = await getHiddenInputs(link, cookies);
        if (!hiddenInputs.oltabid || !hiddenInputs.pggroupid || !hiddenInputs.pkgid) {
            throw new Error('Required hidden inputs not found');
        }

        // Extract the existing username from the form
        const { data: formData } = await axios.get(`${baseURL}${link}`, { 
            headers: { Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}` },
            timeout: 9000 
        });
        const $ = cheerio.load(formData);
        const existingUsername = ($('input#uname').attr('value') || $('input#dusername_org').attr('value') || '').trim();

        // Present options to user
        let optionsMessage = `Choose username option:\n`;
        if (existingUsername) {
            optionsMessage += `1. Default Username: ${existingUsername}\n`;
        }
        optionsMessage += `2. Bot Username: ${derivedUsername}\n`;
        optionsMessage += `3. Input Username manually\n`;
        
        await originalMessage.reply(optionsMessage);
        
        const userChoice = await waitForReply(originalMessage);
        let finalUsername;

        switch(userChoice.body.trim()) {
            case '1':
                if (existingUsername) {
                    const verifiedExisting = await getUsername(hiddenInputs.firstname, existingUsername, cookies);
                    if (verifiedExisting) {
                        finalUsername = existingUsername;
                    } else {
                        return false;
                    }
                }
                break;
            case '2':
                finalUsername = derivedUsername;
                break;
            case '3':
                await originalMessage.reply("Input Manual Username:");
                const manualUsernameMessage = await waitForReply(originalMessage);
                const manualUsername = manualUsernameMessage.body.trim();
                const verifiedManual = await getUsername(hiddenInputs.firstname, manualUsername, cookies);
                if (verifiedManual) {
                    finalUsername = manualUsername;
                } else {
                    return false;
                }
                break;
            default:
                await originalMessage.reply("Invalid option.");
                return false;
        }

        if (!finalUsername) return false;

        const payload = new URLSearchParams({
            oltabid: hiddenInputs.oltabid,
            uname: finalUsername,
            pggroupid: hiddenInputs.pggroupid,
            pkgid: hiddenInputs.pkgid,
            anp: hiddenInputs.anp,
            vlanid: hiddenInputs.vlanid,
            caf_type: hiddenInputs.caf_type,
            railwire_test_name: cookies.railwireCookie.value,
            mobileno: hiddenInputs.mobileno
        }).toString();

        const { status, data: subscriptionResponse } = await axios.post(`${baseURL}/kycapis/create_subscription`, payload, { 
            headers: { 
                Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 9000 
        });
        
        if (subscriptionResponse.STATUS === undefined) {
            throw new Error('Cookie expired during subscription creation');
        }
        
        console.log(status === 200 ? 'Subscription created.' : 'Subscription failed.', subscriptionResponse);
        
        if (status === 200) {
            const userData = await fetchUserDataFromPortal(finalUsername);
            if (userData) {
                const resetResponse = await resetPassword(userData, cookies);
                console.log('Password reset response:', resetResponse);
            } else {
                console.error('Failed to fetch user data for password reset.');
            }
        }
        return status === 200;
    } catch (err) {
        console.error(`Error creating subscription: ${err.message}`);
        return false;
    }
};


const handleVerifiedForm = async (link, cookies, originalMessage) => {
    try {
        const { data } = await axios.get(`${baseURL}${link}`, { 
            headers: { Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}` },
            timeout: 9000 
        });
        const $ = cheerio.load(data);
        const firstName = (await getHiddenInputs(link, cookies)).firstname?.split(' ')[0]?.toLowerCase();
        if (!firstName) throw new Error('First name not found.');

        const associatedPartner = $(`.profile-info-name:contains('Associated Partner')`).next().text().trim().toLowerCase();
        const jhCode = jhCodeMap?.get(associatedPartner);
        if (!jhCode) throw new Error('JH Code not found for partner.');

        const baseUsername = `${jhCode}.${firstName}`;
        const finalUsername = await getUsername(firstName, baseUsername, cookies);
        if (!finalUsername) throw new Error('Failed to derive username.');

        return await createSubscription(link, finalUsername, cookies, originalMessage);
    } catch (err) { 
        console.error(`Error processing verified form: ${err.message}`); 
        return false;
    }
};

const handleSubmittedForm = async (link, oltabid, cookies, username, originalMessage) => {
    try {
      const { data } = await axios.get(`${baseURL}${link}`, { 
        headers: { Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}` },
        timeout: 8000
      });
      const $ = cheerio.load(data);
  
      // Extracting Address Proof
      const addressProofElement = $(`.profile-info-name:contains('Address Proof Copy')`).next().find('span');
      const addressProof = addressProofElement.length > 0 && addressProofElement.text().trim().toLowerCase() === 'file not exists' ? 'file not exists' : 'View';
      const mobileNo = $(`.profile-info-name:contains('Mobile No.')`).next().find('span').text().trim();
  
      if (addressProof === 'file not exists') {
        console.log('Marking as verified because file not exists.');
        const payload = new URLSearchParams({ 
          oltabid, 
          mobileno_dual: mobileNo, 
          railwire_test_name: cookies.railwireCookie.value 
        }).toString();
        await axios.post(`${baseURL}/kycapis/kyc_mark_verified`, payload, { 
          headers: { 
            Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 5000 
        });
        return true;
      } else {
        console.log(`Address proof exists for mobile ${mobileNo}.`);

        let extractedData = `Address Proof for No.: ${mobileNo}\n\nDetails:\n`;
    
        $('.profile-info-row').each((index, element) => {
          const infoName = $(element).find('.profile-info-name').text().trim();
          const infoValueElement = $(element).find('.profile-info-value span');
  
          let infoValue = infoValueElement.text().trim();
  
          // Handle links specifically
          const linkElement = infoValueElement.find('a');
          if (linkElement.length > 0) {
            const link = linkElement.attr('href');
            infoValue = `View >> ${baseURL}${link}`;
          }
  
          if (
            !infoName.toLowerCase().includes('notice') &&
            !infoName.toLowerCase().includes('reason for kyc rejection') &&
            !infoName.toLowerCase().includes('address type') &&
            !infoName.toLowerCase().includes('id no') &&
            !infoName.toLowerCase().includes('door no') &&
            !infoName.toLowerCase().includes('street') &&
            !infoName.toLowerCase().includes('applied package')
          ) {
            extractedData += `${infoName}: ${infoValue}\n`;
          }
        });
  
        // Send the extracted data to the user
        await originalMessage.reply(extractedData);
        await originalMessage.reply(`Do you want to verify? (y/n)`);
  
        const userInputMessage = await waitForReply(originalMessage);
        const userInput = userInputMessage.body.toLowerCase();
  
        if (userInput.startsWith('y')) {
          const payload = new URLSearchParams({ 
            oltabid, 
            mobileno_dual: mobileNo, 
            railwire_test_name: cookies.railwireCookie.value 
          }).toString();
          await axios.post(`${baseURL}/kycapis/kyc_mark_verified`, payload, { 
            headers: { 
              Cookie: `railwire_cookie_name=${cookies.railwireCookie.value}; ci_session=${cookies.ciSessionCookie.value}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 5000 
          });
          return true;
        } else {
          console.log('User choose not to verify. Skipping verification.');
          return false;
        }
      }
    } catch (err) { 
      console.error(`Error processing submitted form for ${username}: ${err.message}`); 
      return false;
    }
  };
 
const handleIncomingMessage = async (message) => {
    const chat = await message.getChat();
    if (chat.isGroup && chat.name === 'Railtel & MSP team Jharkhand') {
        console.log('MSP group messages ignoring!!');
        return;
    }

    const userIdentifier = getUserIdentifier(message);
    const messageBody = message.body.toLowerCase().trim();

    console.log(`User Detail: ${userIdentifier}`);
    console.log(`Message: ${messageBody}`);

    if (messageBody === 'ticketupdate') {
        await handleTicketActivation(message);
        return;
    }
    if (messageBody.includes('checkott')) {
        await checkComplaintStatus(message);
        return;
    }

    if (messageBody === 'slastart') {
        await createSLATicket(message);
        return;
    }

    if (messageBody === 'planupdate') {
        await handlePlanChange(message);
        return;
    }

    if (messageBody === 'cafupdate') {
        if (!cookies) {
            await message.reply('Failed to authenticate. Please try again later.');
            return;
        }

        await message.reply('Looking for KYC...');
        const totalProcessed = await processAllForms(cookies, message);
        await message.reply(`Processed + Verified: ${totalProcessed}`);
        return;
    }

    // Pattern matching for JH codes and subscriber IDs
    let codePattern = /jh(\.\w+){2,}/i;
    let codeMatch = messageBody.match(codePattern);
    let subscriberIdPattern = /\b\d{5}\b/;
    let subscriberIdMatch = messageBody.match(subscriberIdPattern);
    let currentUserCodeOrId = codeMatch ? codeMatch[0].toLowerCase() : (subscriberIdMatch ? subscriberIdMatch[0] : null);

    if (currentUserCodeOrId) {
        userSessions.set(userIdentifier, { userCode: currentUserCodeOrId, userData: null });
    }

    // Check for OTT issues in the same message or session
    const ottIssueKeywords = /\b(hotstar|zee5|sony|amazon|alt|jio|saavn|ott)\b/i;
    const hasOttIssue = ottIssueKeywords.test(messageBody);

    // Standard action keywords
    const wantsSessionReset = /\b(season|session|ip reset|mac)\b/i.test(messageBody);
    const wantsDeactiveID = /\b(reactive|reactivate|inactive)\b/i.test(messageBody);
    const wantsPasswordReset = /\b(reset|risat|resat|resert|risit|rest|reser|riset)\b/i.test(messageBody);

    // Handle OTT complaint with automatic service detection
    if (hasOttIssue && userSessions.has(userIdentifier)) {
        await processOTTComplaint(message, userIdentifier);
        return;
    }

    // Handle standard actions (reset, session, deactivate)
    if ((wantsSessionReset || wantsPasswordReset || wantsDeactiveID) && userSessions.has(userIdentifier)) {
        await processActions(message, userIdentifier, wantsSessionReset, wantsPasswordReset, wantsDeactiveID);
    }
};

client.on('ready', () => {
    loadAllData();
    botStartTime = Date.now();
    console.log('WhatsApp bot ready to use!!');
});

client.on('qr', generateQRCode);

client.on('message', (message) => {
    if (message.timestamp * 1000 < botStartTime) {
        return;
    }
    
    handleIncomingMessage(message);
});

client.initialize();