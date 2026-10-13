# Nix passes this public SPKI to unpacked Chrome and Chromium builds.
# Chrome derives the same development ID on each machine from the key.
{
  publicKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtqj0b03wCdlH40VD3mtDBILuD090AdL6xTbYa+YT+bckM6nxYLI7ztfT72eF5ZZxCiU1G4QO6AD1jbuHok9KZqLBI0C1cT9du1/fOFIsj9BO9UUaKocA4QW3XbZ18rUhn12Rn+c9lZSFyc66YWZtmr9LYPy6c+CffrH68UlWLySV45mhRc0cQp4keY/LcwV5zINpTuHObnZIl7IMf50BydC/GWc3NMDUSLQEKJnGlJkhVmAixEVsXo3a5VKJ8p8GZI0mfLtRR5BFFK0kQP/fxovQ/J+zK71Y1Q+lErnx3bPUh0rDA5EzMS48EL1WASXdcVjl6xXwt+Mcbk/lJ+uvuQIDAQAB";
  chromeId = "fijpffccadekllfkkfelnknanpljbobb";
}
