const fs = require('fs');
const axios = require('axios');

// Read clientID from token.reddit.dev file
const clientID = fs.readFileSync(__dirname + '/token.reddit', 'utf8').trim()

// Token for reddit API
let token, tokenExpiresMS = 0, tokenPromise

// TODO: respect login API limits?
const getToken = async () => {
  // We have already gotten a token
  if (token && tokenExpiresMS > Date.now())
    return token

  // We are already waiting to get a token
  if (tokenPromise)
    return (await tokenPromise).access_token

  // Headers for getting reddit api token
  const tokenInit = {
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientID}:`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'
    }
  }

  tokenPromise = axios.post('https://www.reddit.com/api/v1/access_token',
    `grant_type=${encodeURIComponent('https://oauth.reddit.com/grants/installed_client')}&device_id=DO_NOT_TRACK_THIS_DEVICE`,
    tokenInit
  ).then(res => res.data)

  try {
    const response = await tokenPromise
    tokenExpiresMS = Date.now() + 1000*( parseInt(response.expires_in) - 10 )
    token = response.access_token
  } catch (error) {
      console.error('reddit.getToken ->')
      throw error
  } finally {
    tokenPromise = undefined
  }
  return token
}

// Get header for general api calls
const getAuth = () => {
  return getToken()
    .then(token => ({
      headers: {
        Authorization: `bearer ${token}`
      }
    }))
}

module.exports = { getAuth };
