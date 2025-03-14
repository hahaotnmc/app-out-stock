import { useEffect, useState } from "react";
import { useSubmit, useRevalidator, useActionData, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  TextField,
  Badge,
  IndexTable,
  useIndexResourceState,
  InlineStack,
  InlineGrid,
  Box,
  IndexFilters,
  useSetIndexFiltersMode,
  
} from "@shopify/polaris";
import { ChartDonutIcon, DeleteIcon, PlusIcon } from "@shopify/polaris-icons";

import { TitleBar, Modal, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import "../assets/css/styles.css";

// Thư viện PA-API v5
import ProductAdvertisingAPIv1 from "paapi5-nodejs-sdk";
import { useLoaderData } from "@remix-run/react";

/* -------------- TÁCH ASIN TỪ URL AMAZON -------------- */
function extractAsinFromUrl(url) {
  const regex = /\/([A-Z0-9]{10})(?:[/?]|$)/i;
  const match = url?.match(regex);
  return match ? match[1] : null;
}

/**
 * Lấy thông tin cơ bản (title, price, image...) bằng getItems,
 * sau đó (nếu có VariationSummary) => gọi getVariations lấy danh sách biến thể child.
 */
function fetchAmazonProductDataByASIN(asin) {
  return new Promise(async (resolve, reject) => {
    try {
      // 1) Lấy thông tin item gốc qua getItems
      const baseData = await getItemByASIN(asin);
      const { title, price, imageUrl, features, imageVariantUrls } = baseData;
      // Thêm timeout 500ms
      await new Promise((resolve) => setTimeout(resolve, 2000));
      let variantsData = [];
      try {
        variantsData = await getVariations(asin);
        // variantsData sẽ là mảng [{asin, title, price, ...}, ...]
      } catch (err) {
        console.error("Error fetching variations");
        // Không bắt buộc ném lỗi, tuỳ bạn
      }

      // 3) resolve gộp data
      resolve({
        title,
        price,
        imageUrl,
        features,
        imageVariantUrls,
        variantsData, // mảng child
      });
    } catch (error) {
      reject(error);
    }
  });
}

function getItemByASIN(asin) {
  return new Promise((resolve, reject) => {
    const defaultClient = ProductAdvertisingAPIv1.ApiClient.instance;
    defaultClient.accessKey = process.env.AMAZON_PAAPI_ACCESS_KEY;
    defaultClient.secretKey = process.env.AMAZON_PAAPI_SECRET_KEY;
    defaultClient.host = "webservices.amazon.com";
    defaultClient.region = "us-east-1";

    const api = new ProductAdvertisingAPIv1.DefaultApi();

    const getItemsRequest = new ProductAdvertisingAPIv1.GetItemsRequest();
    getItemsRequest.PartnerTag = process.env.AMAZON_PAAPI_PARTNER_TAG; // "xxxx-20"
    getItemsRequest.PartnerType = "Associates";
    getItemsRequest.ItemIds = [asin];
    getItemsRequest.Resources = [
      "Images.Primary.Medium",
      "Images.Variants.Medium",
      "ItemInfo.Title",
      "ItemInfo.Features",
      "Offers.Listings.Price",
      // Có thể thêm VariationSummary để check VariationCount,
      // nhưng nếu API không trả, cũng không sao.
    ];

    api.getItems(getItemsRequest, (error, data) => {
      if (error) return reject(error);

      const getItemsResponse = ProductAdvertisingAPIv1.GetItemsResponse.constructFromObject(
        data
      );
      const item = getItemsResponse?.ItemsResult?.Items?.[0];
      if (!item) {
        return reject(new Error(`Không tìm thấy sản phẩm cho ASIN: ${asin}`));
      }

      const title = item?.ItemInfo?.Title?.DisplayValue ?? "Unknown Title";
      const price = item?.Offers?.Listings?.[0]?.Price?.DisplayAmount ?? "0.00";
      const features = item?.ItemInfo?.Features?.DisplayValues ?? [
        "No features",
      ];
      const imageUrl =
        item?.Images?.Primary?.Medium?.URL ?? "https://via.placeholder.com/150";
      const imageVariantUrls = item?.Images?.Variants || [];

      // Trả về data gốc
      resolve({
        title,
        price,
        features,
        imageUrl,
        imageVariantUrls,
      });
    });
  });
}

export function getVariations(asin) {
  return new Promise((resolve, reject) => {
    // 1) Thiết lập client
    const defaultClient = ProductAdvertisingAPIv1.ApiClient.instance;
    defaultClient.accessKey = process.env.AMAZON_PAAPI_ACCESS_KEY;
    defaultClient.secretKey = process.env.AMAZON_PAAPI_SECRET_KEY;
    defaultClient.host = "webservices.amazon.com";
    defaultClient.region = "us-east-1";

    // 2) Tạo instance
    const api = new ProductAdvertisingAPIv1.DefaultApi();

    // 3) Tạo request
    const getVariationsRequest = new ProductAdvertisingAPIv1.GetVariationsRequest();
    getVariationsRequest.PartnerTag = process.env.AMAZON_PAAPI_PARTNER_TAG; // "<YOUR PARTNER TAG>"
    getVariationsRequest.PartnerType = "Associates";
    getVariationsRequest.ASIN = asin;

    // Resources: Thêm "VariationSummary.VariationDimension"
    getVariationsRequest.Resources = [
      "Images.Primary.Medium",
      "ItemInfo.Title",
      "Offers.Listings.Price",
      "VariationSummary.VariationDimension",
    ];

    // 4) Gọi API
    api.getVariations(getVariationsRequest, (error, data) => {
      if (error) {
        return reject(error);
      }

      // Xây dựng kết quả từ response
      const getVariationsResponse = ProductAdvertisingAPIv1.GetVariationsResponse.constructFromObject(
        data
      );

      // console.log(
      //   "Complete Response:\n" + JSON.stringify(getVariationsResponse, null, 2)
      // );

      // Kiểm tra Errors
      if (getVariationsResponse.Errors) {
        const firstErr = getVariationsResponse.Errors[0];
        return reject(
          new Error(firstErr?.Message || "Unknown PA-API error occurred")
        );
      }

      const variationsResult = getVariationsResponse.VariationsResult;
      if (!variationsResult) {
        // Không có biến thể
        return resolve({
          variationCount: 0,
          variationDimensions: [],
          items: [],
        });
      }

      // VariationSummary => VariationCount, VariationDimension (mảng chuỗi)
      const variationSummary = variationsResult.VariationSummary;
      const variationCount = variationSummary?.VariationCount || 0;
      // “VariationDimension” có thể là mảng, ví dụ: ["Size", "Color"]

      const variationDimensions = variationSummary?.VariationDimensions || [];
      // Mảng items => từng biến thể con (ASIN, Title, Price, vv.)
      const items = variationsResult.Items || [];

      // Trả về data: { variationCount, variationDimensions, items }
      resolve({
        variationCount,
        variationDimensions,
        items,
      });
    });
  });
}

/**
 * Tạo map: AmazonDimensionName => { optionId, shopifyName }
 *
 * @param {Array} variationDimensions - Mảng Dimension Amazon,
 *    [{ DisplayName: "Size", Name: "size_name" }, ...]
 * @param {Array} shopifyOptions - Mảng Option Shopify,
 *    [{ id, name, optionValues, ... }, ...]
 * @returns {Object}
 *    {
 *      size_name: { optionId: "gid://shopify/ProductOption/AAA", shopifyName: "Size" },
 *      style_name: { optionId: "gid://shopify/ProductOption/BBB", shopifyName: "Style" }
 *    }
 */
function buildDimensionMap(variationDimensions, shopifyOptions) {
  const map = {};

  variationDimensions.forEach((dim) => {
    // dim.Name => "style_name"
    // dim.DisplayName => "Style"

    // Tìm ShopOption có name === "Style"
    const shopifyOption = shopifyOptions.find(
      (opt) => opt.name === dim.DisplayName
    );
    if (shopifyOption) {
      map[dim.Name] = {
        optionId: shopifyOption.id,
        name: shopifyOption.name, // "Style" / "Size" ...
      };
    } else {
      // Nếu không khớp => tuỳ logic
      console.warn(
        `Không tìm thấy Shopify option cho DisplayName=${dim.DisplayName}`
      );
    }
  });

  return map;
}
/**
 * Tạo input cho `productVariantsBulkCreate(productId, variants)`,
 * BỎ QUA items Amazon nếu ANY optionValue (Shopify side) có `hasVariants = true`.
 *
 * @param {Array} rawAmazonVariants - mảng item Amazon
 *    Ex: [ { Offers, VariationAttributes, ... }, ... ]
 * @param {string} productId - e.g. "gid://shopify/Product/20995642"
 * @param {Object} optionIdMap - map dimensionName => optionId
 *    Ex: { size_name: "gid://shopify/ProductOption/111", color_name: "gid://shopify/ProductOption/222" }
 * @param {Array} shopifyOptions - list of productOptions =>
 *    Ex: [
 *      {
 *        id: "gid://shopify/ProductOption/111",
 *        name: "Size",
 *        optionValues: [
 *          { id: "...", name: "150 sheet (Pack of 6)", hasVariants: false },
 *          { id: "...", name: "150 sheet (Pack of 2)", hasVariants: true },
 *        ]
 *      },
 *      ...
 *    ]
 * @returns {Object} => { productId, variants: [ { price, compareAtPrice?, optionValues: [...] }, ... ] }
 */
function buildBulkCreateInput(
  rawAmazonVariants,
  productId,
  optionIdMap,
  shopifyOptions,
  locs
) {
  const variants = [];

  for (const item of rawAmazonVariants) {
    // Lấy giá
    const listing = item?.Offers?.Listings?.[0];
    const amount = listing?.Price?.Amount ?? 0;
    const compareAt = listing?.Price?.CompareAtPrice ?? undefined;

    // Mảng VariationAttributes => e.g. [ { Name: "size_name", Value: "150 sheet (Pack of 6)" }, ...]
    const variationAttributes = item?.VariationAttributes || [];

    // Mảng optionValues[] => cho ProductVariantsBulkInput
    const optionValues = [];
    //let skipThisVariant = false;
    const skuValue = item.SKU || item.ASIN || "";
    // Lấy mediaSrc từ item (sử dụng ảnh chính của variant, nếu có)
    const mediaSrcUrl = item?.Images?.Primary?.Medium?.URL || null;

    for (const attr of variationAttributes) {
      const dimensionName = attr.Name; // e.g. "size_name"
      const dimensionValue = attr.Value; // e.g. "150 sheet (Pack of 6)"

      // Lấy optionId => e.g. "gid://shopify/ProductOption/111"
      const optionId = optionIdMap[dimensionName].optionId;
      if (!optionId) {
        // Không tìm thấy => có thể skip item hoặc cứ thêm ??? Tuỳ logic
        console.warn("No optionId for dimension:", dimensionName);
        continue;
      }
      // Tìm object productOption => { id, name, optionValues: [] }
      const productOption = shopifyOptions.find((opt) => opt.id === optionId);
      if (!productOption) {
        console.warn("No matching productOption for id:", optionId);
        continue;
      }
      // Tìm optionValue => so khớp "name" = dimensionValue
      const matchingVal = productOption.optionValues.find(
        (ov) => ov.name === dimensionValue
      );
      // Nếu hasVariants = true => skip entire item
      // if (matchingVal?.hasVariants) {
      //   skipThisVariant = true;
      //   console.log(
      //     `Skipping item: dimensionValue=${dimensionValue} hasVariants=true`
      //   );
      //   break; // break for VariationAttributes
      // }

      // Thêm { name, optionId } cho variant
      optionValues.push({
        name: dimensionValue, // e.g. "150 sheet (Pack of 6)"
        optionId: productOption.id, // e.g. "gid://shopify/ProductOption/111"
      });
    }

    // Nếu skip => đừng push variant
    // if (skipThisVariant) {
    //   continue;
    // }

    // Tạo variant object
    const variantInput = {
      price: amount.toString(),
      optionValues,
      inventoryItem: {
        sku: skuValue,
      },
      inventoryQuantities: locs.data.locations.edges.map((loc) => ({
        availableQuantity: 100,
        locationId: loc.node.id,
      })),
    };
    if (compareAt) {
      variantInput.compareAtPrice = compareAt.toString();
    }

    if (mediaSrcUrl) {
      // Thêm mediaSrc là mảng chứa URL
      variantInput.mediaSrc = [mediaSrcUrl];
    }

    variants.push(variantInput);
  }

  return {
    productId,
    strategy: "REMOVE_STANDALONE_VARIANT",
    variants,
  };
}

/* ------------------ REMIX LOADER ------------------ */
export const loader = async ({ request }) => {
  // Kiểm tra quyền admin (nếu cần)
  const { session } = await authenticate.admin(request);
  const products = await prisma.product.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: 'desc' },
  });
  return { products: products || [] };
};

/* ------------------ REMIX ACTION ------------------ */
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop } = session;
  const formData = await request.formData();
  const productUrl = formData.get("productUrl");
  const productIds = formData.get("productIds");
  if (productIds) {
    const idsArray = productIds.split(",");
    try {
      for (const id of idsArray) {
        await admin.graphql(
          `#graphql
          mutation productDelete($input: ProductDeleteInput!) {
            productDelete(input: $input) {
              deletedProductId
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              input: {
                id: id,
              },
            },
          }
        );
        await prisma.product.delete({
          where: { shopifyId: id },
        });
      }

      return { message: "Products deleted successfully" };
    } catch (error) {
      console.error("Error deleting products:", error);
      return { error: "Failed to delete products" };
    }
  }

  if (!productUrl) {
    return { error: "Missing Amazon product URL" };
  }

  let locs;
  try {
    const response = await admin.graphql(`
      {
        locations(first: 10) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    `);
    locs = await response.json();
  } catch (error) {
    console.error("Error fetching locations:", error);
    return { error: "Failed to fetch locations" };
  }

  // Tách ASIN
  const asin = extractAsinFromUrl(productUrl);
  if (!asin) {
    return { error: "Could not extract ASIN from URL" };
  }

  try {
    // 1) Gọi PA-API => Lấy data, trong đó mong có variationDimensions
    //    ví dụ variationDimensions = [
    //      { displayName: "Size", values: ["Small", "Large"] },
    //      { displayName: "Color", values: ["Red", "Blue"] }
    //    ]
    const {
      title,
      price,
      imageUrl,
      features,
      imageVariantUrls,
      variantsData, // tuỳ: mảng child (nếu getVariations)
    } = await fetchAmazonProductDataByASIN(asin);

    // 2) Tạo chuỗi HTML mô tả, ảnh media
    const featuresHtml = `<ul>${features
      .map((f) => `<li>${f}</li>`)
      .join("")}</ul>`;

    const media = [
      { originalSource: imageUrl, mediaContentType: "IMAGE" },
      ...imageVariantUrls.map((variant) => ({
        originalSource: variant.Medium.URL,
        mediaContentType: "IMAGE",
      })),
    ];

    // 3) Nếu ta có "variationDimensions", ta chuyển sang "options" + "variants"
    //    Shopify Admin GraphQL:
    //    - "options": string[] (tối đa 3, vd ["Size","Color"])
    //    - "variants": ProductVariantInput[] => { option1, option2, price, sku... }
    // Demo: Giả định user có 2 dimension => Size / Color
    //console.log(JSON.stringify(variantsData.items));
    let variationDimensions = variantsData?.variationDimensions || [];
    // (Tùy theo fetchAmazonProductDataByASIN bạn viết)

    // Lấy array name ["Size","Color"]
    const options = (variationDimensions || []).map((dim) => ({
      name: dim.DisplayName, // ví dụ "Size"
      values: dim.Values.map((val) => ({ name: val })), // GIỮ NGUYÊN chuỗi
    }));

    const createProduct = await admin.graphql(
      `#graphql
      mutation createProduct(
        $title: String!,
        $descriptionHtml: String!,
        $media: [CreateMediaInput!]!,
        $productOptions: [OptionCreateInput!]!
      ) {
        productCreate(
          media: $media,
          product: {
            title: $title
            descriptionHtml: $descriptionHtml
            productOptions: $productOptions
          }
        ) {
          product {
            id
            title
            options {
              id
              name
              position
              optionValues {
                id
                name
                hasVariants
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
      `,
      {
        variables: {
          title,
          descriptionHtml: featuresHtml,
          media,
          productOptions: options,
        },
      }
    );
    const createProductRes = await createProduct.json();

    const userErrors = createProductRes?.data?.productCreate?.userErrors;
    if (userErrors?.length) {
      return { error: userErrors[0].message };
    }

    const product = createProductRes.data.productCreate.product;
    if (!product) {
      return { error: "No product created" };
    }
    console.log("Product created:", product);
    const productId = product.id;
    //const newVariants = buildBulkVariants(variantsData, finalDimensionNames, productOptions);
    const shopifyOptions = product.options;

    const dimensionMap = buildDimensionMap(variationDimensions, shopifyOptions);
    //console.log("Dimension Map =>", dimensionMap);

    // rawAmazonVariants: Mảng items do PA-API trả
    const input = buildBulkCreateInput(
      variantsData.items,
      productId,
      dimensionMap,
      shopifyOptions,
      locs
    );
    // console.log(JSON.stringify(product, null, 2));
    // console.log(JSON.stringify(input, null, 2));

    const response = await admin.graphql(
      `#graphql
      mutation ProductVariantsCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
          productVariants {
            id
            title
            selectedOptions {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: input,
      }
    );

    const createdVariants = await response.json();

    // Lưu sản phẩm vào DB với Prisma
    const variants =
      createdVariants.data.productVariantsBulkCreate.productVariants;
    if (variants && variants.length > 0) {
      await prisma.product.create({
        data: {
          shopifyId: product.id,
          title: product.title,
          price: parseFloat(price.replace(/[^0-9.]/g, "")),
          variantsCount: variants.length,
          image: imageUrl,
          status: "ACTIVE",
          amazonLink: productUrl,
          shop, // Thay bằng shop thực tế, có thể lấy từ session
        },
      });
      return {
        product,
        createdVariants,
        message: "Sản phẩm được tạo thành công",
      };
    } else {
      return { error: "Failed to create product variants" };
    }
  } catch (error) {
    console.error("Action error:", error);
    return { error: error.message };
  }
};

/* ------------------ UI COMPONENT ------------------ */
// Removed duplicate loader function

export default function Index() {
  const { products = [] } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const [itemStrings, setItemStrings] = useState(["All", "Active", "Disabled"]);
  const [isLoading, setIsLoading] = useState(false);
  const [productUrl, setProductUrl] = useState(
    "https://www.amazon.com/dp/B09BWFX1L6"
  );
  const navigation = useNavigation();

  const handleImport = () => {
    setIsLoading(true);
    submit({ productUrl }, { method: "post" });
  };

  useEffect(() => {
    if (actionData && actionData.product?.id) {
      shopify.toast.show(`Product created!`);
      revalidator.revalidate();
      setIsLoading(false);
    }
    if (actionData && actionData.error) {
      shopify.toast.show(`Error`);
      setIsLoading(false);
    }
  }, [actionData]);

  const handleRemove = async () => {
    shopify.modal.hide("confirm-remove");
    await submit({ productIds: selectedResources }, { method: "delete" });
  };

  const resourceName = {
    singular: "product",
    plural: "products",
  };

  const {
    selectedResources,
    allResourcesSelected,
    handleSelectionChange,
  } = useIndexResourceState(products, {
    resourceIDResolver: (product) => product.shopifyId,
  });
  const [queryValue, setQueryValue] = useState("");
  const [sortSelected, setSortSelected] = useState(["order asc"]);
  const [selected, setSelected] = useState(0);
  const [appliedFilters, setAppliedFilters] = useState([]);
  const [filters, setFilters] = useState([]);
  const [primaryAction, setPrimaryAction] = useState({});
  const [sortOptions, setSortOptions] = useState([
    { label: "Order", value: "order asc", directionLabel: "Ascending" },
    { label: "Order", value: "order desc", directionLabel: "Descending" },
    { label: "Customer", value: "customer asc", directionLabel: "A-Z" },
    { label: "Customer", value: "customer desc", directionLabel: "Z-A" },
    { label: "Date", value: "date asc", directionLabel: "A-Z" },
    { label: "Date", value: "date desc", directionLabel: "Z-A" },
    { label: "Total", value: "total asc", directionLabel: "Ascending" },
    { label: "Total", value: "total desc", directionLabel: "Descending" },
  ]);
  const { mode, setMode } = useSetIndexFiltersMode();
  const tabs = itemStrings.map((item, index) => ({
    content: item,
    index,
    onAction: () => {
      setStatus(item);
      setFilterParams("status", item);
    },
    id: `${item}-${index}`,
    isLocked: index === 0,
  }));

  const promotedBulkActions = [
    {
      content: "Activate",
      onAction: () => handleActivate(),
    },
    {
      content: "Deactivate",
      onAction: () => handleDeactivate(),
    },
  ];

  const bulkActions = [
    {
      icon: DeleteIcon,
      destructive: true,
      content: "Delete products",
      onAction: () => shopify.modal.show("confirm-remove"),
    },
  ];  

  const handleFiltersQueryChange = (value) => {
    setQueryValue(value);
  };

  const handleFiltersClearAll = () => {
    setAppliedFilters([]);
  };

  const onHandleCancel = () => {
    // Handle cancel action
  };

  return (
    <Page>
      <TitleBar title="Amazon Importer" />

      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <BlockStack gap="500">
              <Card>
                <BlockStack gap="200">
                  <BlockStack gap="200">
                    <Text>Amazon Product URL</Text>
                    <InlineGrid gap={200} columns={"1fr auto"}>
                      <TextField
                        value={productUrl}
                        onChange={(val) => setProductUrl(val)}
                        placeholder="https://www.amazon.com/dp/B08J5VQX9Y"
                      />
                      <Button
                        variant="primary"
                        onClick={handleImport}
                        disabled={isLoading}
                      >
                        Import
                      </Button>
                    </InlineGrid>
                  </BlockStack>
                </BlockStack>
              </Card>

              <Card padding="0" title="Existing Products" sectioned>
                <IndexFilters
                  sortOptions={sortOptions}
                  sortSelected={sortSelected}
                  queryValue={queryValue}
                  queryPlaceholder="Searching in all"
                  onQueryChange={handleFiltersQueryChange}
                  onQueryClear={() => setQueryValue("")}
                  onSort={setSortSelected}
                  primaryAction={primaryAction}
                  cancelAction={{
                    onAction: onHandleCancel,
                    disabled: false,
                    loading: false,
                  }}
                  tabs={tabs}
                  selected={selected}
                  onSelect={setSelected}
                  canCreateNewView={false}
                  filters={filters}
                  appliedFilters={appliedFilters}
                  onClearAll={handleFiltersClearAll}
                  mode={mode}
                  setMode={setMode}
                  loading={navigation.state !== "idle" ? true : false}
                />
                <IndexTable
                  resourceName={resourceName}
                  itemCount={products.length}
                  selectedItemsCount={
                    allResourcesSelected ? "All" : selectedResources.length
                  }
                  onSelectionChange={handleSelectionChange}
                  headings={[
                    { title: "Image" },
                    { title: "Title" },
                    { title: "Price" },
                    { title: "Status" },
                    { title: "Variants" },
                    { title: "Actions" },
                  ]}
                  promotedBulkActions={promotedBulkActions}
                  bulkActions={bulkActions}                  
                >
                  {products.map((prod, index) => (
                    <IndexTable.Row
                      id={prod.shopifyId}
                      key={prod.shopifyId}
                      selected={selectedResources.includes(prod.shopifyId)}
                      position={index}
                    >
                      <IndexTable.Cell>
                        <img src={prod.image} alt={prod.title} width="50" />
                      </IndexTable.Cell>
                      <IndexTable.Cell style={{ maxWidth: "200px" }}>
                        <div
                          style={{
                            maxWidth: "200px",
                            overflow: "hidden",
                            whiteSpace: "normal",
                            wordBreak: "break-word",
                          }}
                        >
                          <a
                            className="alink"
                            onClick={(e) => {
                              e.stopPropagation();
                              window.open(
                                `https://${
                                  prod.shop
                                }/admin/products/${prod.shopifyId.replace(
                                  "gid://shopify/Product/",
                                  ""
                                )}`,
                                "_blank"
                              );
                            }}
                          >
                            {prod.title}
                          </a>
                        </div>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{prod.price}</IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge
                          tone={
                            prod.status === "ACTIVE" ? "success" : "attention"
                          }
                        >
                          {prod.status}
                        </Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{prod.variantsCount}</IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap={100}>
                          {prod.amazonLink && (
                            <Button
                              onClick={(e) => {
                                e.stopPropagation();
                                window.open(prod.amazonLink, "_blank");
                              }}
                            >
                              View on Amazon
                            </Button>
                          )}
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              </Card>
              <Modal id="confirm-remove">
                <Box padding={400}>
                  <Text>
                    Deleting product can‘t be undone. Are you sure you want to
                    delete the selected product?
                  </Text>
                </Box>

                <TitleBar title="Remove product">
                  <button onClick={() => shopify.modal.hide("confirm-remove")}>
                    Cancel
                  </button>
                  <button
                    variant="primary"
                    tone="critical"
                    onClick={handleRemove}
                  >
                    Delete
                  </button>
                </TitleBar>
              </Modal>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
