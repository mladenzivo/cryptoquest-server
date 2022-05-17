const fs = require('fs');
const path = require('path');
const retry = require('async-retry');

const pool = require('../config/db.config');
const {
  calculateStatTier,
  calculateCosmeticTier,
} = require('../utils/calculateTiers');
const { randomInteger } = require('../utils/randomInteger');
const { extractHashFromIpfsUrl } = require('../utils/pinata');
const {
  nftStages,
  cosmeticTraitsMap,
  uploadIpfsType,
} = require('../variables/nft.variables');
const {
  updateMetadataUrlSolana,
  fetchOldMetadata,
  throwErrorNoMetadata,
} = require('../utils/solana');
const {
  getHeroTierImageFromIpfs,
  checkIsTokenAlreadyRevealed,
  throwErrorTokenAlreadyRevealed,
  selectTokenByAddress,
  throwErrorTokenHasNotBeenRevealed,
  checkIsTokenAlreadyCustomized,
  throwErrorTokenAlreadyCustomized,
} = require('../utils/nft.utils');
const { addBlenderRender } = require('../queues/blenderRender.queue');
const { addUploadIpfs } = require('../queues/uploadIpfs.queue');
const keypair = path.resolve(__dirname, `../config/keypair.json`);

const metadataFolderPath = '../../../metadata/';
const blenderOutputFolderPath = '../../../blender_output/';
const pinataApiKey = process.env.PINATA_API_KEY;
const pinataSecretApiKey = process.env.PINATA_API_SECRET_KEY;
const pinataGateway = process.env.PINATA_GATEWAY;

const getRandomTokenFromRecipe = async (recipe) => {
  return await retry(
    async () => {
      // Select all possible tokens from recipe
      let allTokensFromRecipe;
      if (recipe === 'Woodland Respite') {
        allTokensFromRecipe = await pool.query(
          'SELECT * FROM woodland_respite'
        );
      } else if (recipe === 'Dawn of Man') {
        allTokensFromRecipe = await pool.query('SELECT * FROM dawn_of_man');
      }

      // Select all already revealed tokens from recipe
      const revealedTokensFromRecipe = await pool.query(
        'SELECT * FROM tokens WHERE recipe = $1',
        [recipe]
      );

      const allTokenNumbers = Array.from(
        { length: allTokensFromRecipe?.rows.length },
        (_, i) => i + 1
      );

      const revealedTokenNumbers = revealedTokensFromRecipe?.rows.map(
        (item) => item?.token_number
      );
      // eslint-disable-next-line no-undef
      const revealedTokenNumbersSet = new Set(revealedTokenNumbers);

      const remainingTokenNumbers = allTokenNumbers.filter(
        (item) => !revealedTokenNumbersSet.has(item)
      );

      if (remainingTokenNumbers.length <= 0) {
        throw new Error(`All tokens already revealed`);
      }

      const randomTokenNumberIndex = randomInteger(
        0,
        remainingTokenNumbers.length - 1
      );

      const selectedTokenNumber = remainingTokenNumbers[randomTokenNumberIndex];

      const {
        token_number: tokenNumber,
        stat_points: statPoints,
        cosmetic_points: cosmeticPoints,
        hero_tier: heroTier,
      } = allTokensFromRecipe.rows.find(
        (item) => item?.token_number === selectedTokenNumber
      );

      const statTier = calculateStatTier(statPoints);
      const cosmeticTier = calculateCosmeticTier(cosmeticPoints);

      return {
        tokenNumber,
        statPoints,
        cosmeticPoints,
        statTier,
        cosmeticTier,
        heroTier,
      };
    },
    {
      retries: 5,
    }
  );
};

// Check is nft unique
exports.checkIsTokenIdUnique = async (req, res) => {
  try {
    const { tokenId } = req.body;

    const isTokenIdExistQuery = await pool.query(
      'SELECT EXISTS(SELECT 1 FROM characters WHERE token_id = $1)',
      [tokenId]
    );

    const isTokenIdExist = isTokenIdExistQuery.rows[0].exists;

    res.status(200).send({ isTokenIdExist });
  } catch (error) {
    console.error(error.message);
    res.status(404).send(error.message);
  }
};

// Check available recipes
exports.availableRecipes = async (req, res) => {
  try {
    const allRecipesWoodlandRespite = await pool.query(
      'SELECT * FROM woodland_respite'
    );
    const allRecipesDawnOfMan = await pool.query('SELECT * FROM dawn_of_man');

    const revealedRecipesWoodlandRespite = await pool.query(
      'SELECT * FROM tokens WHERE recipe = $1',
      ['Woodland Respite']
    );
    const revealedRecipesDawnOfMan = await pool.query(
      'SELECT * FROM tokens WHERE recipe = $1',
      ['Dawn of Man']
    );

    const remainingRecipesWoodlandRespite =
      allRecipesWoodlandRespite.rows.length -
      revealedRecipesWoodlandRespite.rows.length;
    const remainingRecipesDawnOfMan =
      allRecipesDawnOfMan.rows.length - revealedRecipesDawnOfMan.rows.length;

    res.status(200).send({
      woodlandRespite: remainingRecipesWoodlandRespite,
      dawnOfMan: remainingRecipesDawnOfMan,
    });
  } catch (error) {
    console.log(error.message);
    res.status(404).send(error.message);
  }
};

// Reveal Nft
exports.revealNft = async (req, res) => {
  try {
    const { tokenAddress, metadataUri, mintName, mintNumber, recipe } =
      req.body;

    const oldMetadata = await fetchOldMetadata(tokenAddress, metadataUri);
    !oldMetadata && throwErrorNoMetadata(tokenAddress);

    const isTokenAlreadyRevealed = await checkIsTokenAlreadyRevealed(
      tokenAddress
    );
    if (isTokenAlreadyRevealed) {
      throwErrorTokenAlreadyRevealed(tokenAddress);
    }

    console.log(`Start revealing NFT ${tokenAddress}`);

    const {
      tokenNumber,
      statPoints,
      cosmeticPoints,
      statTier,
      cosmeticTier,
      heroTier,
    } = await getRandomTokenFromRecipe(recipe);

    console.log(`Start changing metadata for NFT ${tokenAddress}`);

    const oldMetadataJSON = JSON.stringify(oldMetadata, null, 2);
    const metadataUrlHash = extractHashFromIpfsUrl(metadataUri);
    fs.writeFileSync(
      path.resolve(__dirname, `${metadataFolderPath}${metadataUrlHash}.json`),
      oldMetadataJSON
    );

    const heroTierRecipePath = `${recipe
      .toLowerCase()
      .split(' ')
      .join('_')}_${heroTier.toLowerCase()}`;

    const imageIpfsUrl = getHeroTierImageFromIpfs(heroTierRecipePath);

    const metadata = {
      ...oldMetadata,
      image: imageIpfsUrl,
      external_url: `${process.env.WEBSITE_URL}`,
      recipe,
      stat_points: statPoints,
      cosmetic_points: cosmeticPoints,
      stat_tier: statTier,
      cosmetic_tier: cosmeticTier,
      hero_tier: heroTier,
      properties: {
        ...oldMetadata?.properties,
        files: [
          {
            uri: imageIpfsUrl,
            type: 'image/png',
          },
        ],
      },
    };

    const uploadIpfs = await addUploadIpfs({
      type: uploadIpfsType.json,
      pinataApiKey,
      pinataSecretApiKey,
      pinataGateway,
      data: metadata,
      tokenAddress,
      stage: nftStages.revealed,
    });
    const uploadIpfsResult = await uploadIpfs.finished();
    console.log(uploadIpfsResult);

    const { metadataIpfsUrl, metadataIpfsHash } = uploadIpfsResult;

    const metadataJSON = JSON.stringify(metadata, null, 2);
    fs.writeFileSync(
      path.resolve(__dirname, `${metadataFolderPath}${metadataIpfsHash}.json`),
      metadataJSON
    );

    await updateMetadataUrlSolana(tokenAddress, keypair, metadataIpfsUrl);

    const revealedTokenData = await pool.query(
      'INSERT INTO tokens (token_address, mint_name, recipe, mint_number, token_number, stat_points, cosmetic_points, stat_tier, cosmetic_tier, hero_tier) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
      [
        tokenAddress,
        mintName,
        recipe,
        mintNumber,
        tokenNumber,
        statPoints,
        cosmeticPoints,
        statTier,
        cosmeticTier,
        heroTier,
      ]
    );

    const revealedToken = revealedTokenData.rows[0];

    await pool.query(
      'INSERT INTO metadata (nft_id, stage, metadata_url, image_url) VALUES($1, $2, $3, $4) RETURNING *',
      [revealedToken.id, nftStages.minted, metadataUri, oldMetadata?.image]
    );

    await pool.query(
      'INSERT INTO metadata (nft_id, stage, metadata_url, image_url) VALUES($1, $2, $3, $4) RETURNING *',
      [revealedToken.id, nftStages.revealed, metadataIpfsUrl, imageIpfsUrl]
    );

    console.log(`NFT ${tokenAddress} has been written to the database`);

    res.status(200).send({
      tokenAddress,
      statPoints,
      cosmeticPoints,
      heroTier,
      statTier,
      cosmeticTier,
    });
  } catch (error) {
    console.error(error.message);
    res.status(404).send({
      message: error.message,
    });
  }
};

// Customize NFT
exports.customizeNft = async (req, res) => {
  try {
    const {
      tokenAddress,
      tokenName,
      tokenId,
      cosmeticTraits,
      skills,
      metadataUri,
    } = req.body;

    const oldMetadata = await fetchOldMetadata(tokenAddress, metadataUri);
    !oldMetadata && throwErrorNoMetadata(tokenAddress);

    const currentNft = await selectTokenByAddress(tokenAddress);
    const isTokenAlreadyRevealed = await checkIsTokenAlreadyRevealed(
      tokenAddress
    );
    if (!isTokenAlreadyRevealed) {
      throwErrorTokenHasNotBeenRevealed(tokenAddress);
    }

    const isTokenAlreadyCustomized = await checkIsTokenAlreadyCustomized(
      currentNft.id
    );
    if (isTokenAlreadyCustomized) {
      throwErrorTokenAlreadyCustomized(tokenAddress);
    }

    console.log(`Start customizing NFT ${tokenAddress}`);
    console.log(`Start changing metadata for NFT ${tokenAddress}`);

    const attributes = Object.entries(cosmeticTraits).map((item) => ({
      trait_type: cosmeticTraitsMap[item[0]],
      value: item[1],
    }));

    const blenderRender = await addBlenderRender({
      tokenId,
      cosmeticTraits,
      heroTier: currentNft?.hero_tier,
    });
    const renderResult = await blenderRender.finished();
    console.log(renderResult);

    const image = path.resolve(
      __dirname,
      `${blenderOutputFolderPath}${tokenId}.png` // TODO: change extension
    );

    // TODO: save rendered image on server with imageIpfsHash name
    const uploadImageIpfs = await addUploadIpfs({
      type: uploadIpfsType.image,
      pinataApiKey,
      pinataSecretApiKey,
      pinataGateway,
      data: image,
      tokenAddress,
      stage: nftStages.customized,
    });
    const uploadImageIpfsResult = await uploadImageIpfs.finished();
    console.log(uploadImageIpfsResult);

    const { imageIpfsHash, imageIpfsUrl } = uploadImageIpfsResult;

    const metadataImage = path.resolve(
      __dirname,
      `${metadataFolderPath}${imageIpfsHash}.png` // TODO: change extension
    );

    fs.copyFile(image, metadataImage, (err) => {
      if (err) throw err;
    });

    const metadata = {
      ...oldMetadata,
      image: imageIpfsUrl,
      external_url: `${process.env.WEBSITE_URL}`,
      token_name: tokenName,
      constitution: skills?.constitution,
      strength: skills?.strength,
      dexterity: skills?.dexterity,
      wisdom: skills?.wisdom,
      intelligence: skills?.intelligence,
      charisma: skills?.charisma,
      attributes,
      properties: {
        ...oldMetadata?.properties,
        files: [
          {
            uri: imageIpfsUrl,
            type: 'image/png', // TODO: change extension
          },
        ],
      },
    };

    const uploadJsonIpfs = await addUploadIpfs({
      type: uploadIpfsType.json,
      pinataApiKey,
      pinataSecretApiKey,
      pinataGateway,
      data: metadata,
      tokenAddress,
      stage: nftStages.customized,
    });
    const uploadJsonIpfsResult = await uploadJsonIpfs.finished();
    console.log(uploadJsonIpfsResult);

    const { metadataIpfsUrl, metadataIpfsHash } = uploadJsonIpfsResult;

    const metadataJSON = JSON.stringify(metadata, null, 2);
    fs.writeFileSync(
      path.resolve(__dirname, `${metadataFolderPath}${metadataIpfsHash}.json`),
      metadataJSON
    );

    await updateMetadataUrlSolana(tokenAddress, keypair, metadataIpfsUrl);

    await pool.query(
      'INSERT INTO token_names (nft_id, token_name, token_name_status) VALUES($1, $2, $3) RETURNING *',
      [currentNft.id, tokenName, 'approved']
    );

    await pool.query(
      'INSERT INTO characters (nft_id, token_id, constitution, strength, dexterity, wisdom, intelligence, charisma, race, sex, face_style, eye_detail, eyes, facial_hair, glasses, hair_style, hair_color, necklace, earring, nose_piercing, scar, tattoo, background) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING *',
      [
        currentNft.id,
        tokenId,
        skills.constitution,
        skills.strength,
        skills.dexterity,
        skills.wisdom,
        skills.intelligence,
        skills.charisma,
        cosmeticTraits.race,
        cosmeticTraits.sex,
        cosmeticTraits.faceStyle,
        cosmeticTraits.eyeDetail,
        cosmeticTraits.eyes,
        cosmeticTraits.facialHair,
        cosmeticTraits.glasses,
        cosmeticTraits.hairStyle,
        cosmeticTraits.hairColor,
        cosmeticTraits.necklace,
        cosmeticTraits.earring,
        cosmeticTraits.nosePiercing,
        cosmeticTraits.scar,
        cosmeticTraits.tattoo,
        cosmeticTraits.background,
      ]
    );

    await pool.query(
      'INSERT INTO metadata (nft_id, stage, metadata_url, image_url) VALUES($1, $2, $3, $4) RETURNING *',
      [currentNft.id, nftStages.customized, metadataIpfsUrl, imageIpfsUrl]
    );

    console.log(`NFT ${tokenAddress} has been written to the database`);

    res.status(200).send({ success: 'Success' });
  } catch (error) {
    console.log('ERROR CATCHED: ', error.message);
    res.status(404).send({ message: error.message });
  }
};
