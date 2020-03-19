import BigNumber from "big.js"
import nanoid from "nanoid"
import React from "react"
import { Controller, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Asset, Horizon, Memo, MemoType, Server, Transaction } from "stellar-sdk"
import InputAdornment from "@material-ui/core/InputAdornment"
import TextField from "@material-ui/core/TextField"
import SendIcon from "@material-ui/icons/Send"
import { Account } from "../../context/accounts"
import { AccountRecord, useWellKnownAccounts } from "../../hooks/stellar-ecosystem"
import { useFederationLookup } from "../../hooks/stellar"
import { useIsMobile, RefStateObject } from "../../hooks/userinterface"
import { AccountData } from "../../lib/account"
import { CustomError } from "../../lib/errors"
import { findMatchingBalanceLine, getAccountMinimumBalance } from "../../lib/stellar"
import { isPublicKey, isStellarAddress } from "../../lib/stellar-address"
import { createPaymentOperation, createTransaction, multisigMinimumFee } from "../../lib/transaction"
import { formatBalance } from "../Account/AccountBalances"
import { ActionButton, DialogActionsBox } from "../Dialog/Generic"
import AssetSelector from "../Form/AssetSelector"
import { PriceInput, QRReader } from "../Form/FormFields"
import { HorizontalLayout } from "../Layout/Box"
import Portal from "../Portal"

export interface PaymentFormValues {
  amount: string
  asset: Asset
  destination: string
  memoType: "id" | "none" | "text"
  memoValue: string
}

function createMemo(formValues: PaymentFormValues) {
  switch (formValues.memoType) {
    case "id":
      return Memo.id(formValues.memoValue)
    case "text":
      return Memo.text(formValues.memoValue)
    default:
      return Memo.none()
  }
}

function getSpendableBalance(accountMinimumBalance: BigNumber, balanceLine?: Horizon.BalanceLine) {
  if (balanceLine !== undefined) {
    const fullBalance = BigNumber(balanceLine.balance)
    return balanceLine.asset_type === "native"
      ? fullBalance.minus(accountMinimumBalance).minus(balanceLine.selling_liabilities)
      : fullBalance.minus(balanceLine.selling_liabilities)
  } else {
    return BigNumber(0)
  }
}

interface PaymentFormProps {
  accountData: AccountData
  actionsRef: RefStateObject
  onSubmit: (formValues: PaymentFormValues, spendableBalance: BigNumber, wellknownAccount?: AccountRecord) => void
  testnet: boolean
  trustedAssets: Asset[]
  txCreationPending?: boolean
}

const PaymentForm = React.memo(function PaymentForm(props: PaymentFormProps) {
  const isSmallScreen = useIsMobile()
  const formID = React.useMemo(() => nanoid(), [])
  const { t } = useTranslation()
  const wellknownAccounts = useWellKnownAccounts(props.testnet)

  const [matchingWellknownAccount, setMatchingWellknownAccount] = React.useState<AccountRecord | undefined>(undefined)
  const [memoMetadata, setMemoMetadata] = React.useState({
    label: t("payment.memo-metadata.label.default"),
    placeholder: t("payment.memo-metadata.placeholder.optional")
  })
  const form = useForm<PaymentFormValues>({
    defaultValues: {
      amount: "",
      asset: Asset.native(),
      destination: "",
      memoType: "none",
      memoValue: ""
    }
  })

  const formValues = form.watch()

  // FIXME: Pass no. of open offers to getAccountMinimumBalance()
  const spendableBalance = getSpendableBalance(
    getAccountMinimumBalance(props.accountData),
    findMatchingBalanceLine(props.accountData.balances, formValues.asset)
  )

  React.useEffect(() => {
    if (!isPublicKey(formValues.destination) && !isStellarAddress(formValues.destination)) {
      if (matchingWellknownAccount) {
        setMatchingWellknownAccount(undefined)
      }
      return
    }

    const knownAccount = wellknownAccounts.lookup(formValues.destination)
    setMatchingWellknownAccount(knownAccount)

    if (knownAccount && knownAccount.tags.indexOf("exchange") !== -1) {
      const acceptedMemoType = knownAccount.accepts && knownAccount.accepts.memo
      form.setValue("memoType", acceptedMemoType === "MEMO_ID" ? "id" : "text")
      setMemoMetadata({
        label:
          acceptedMemoType === "MEMO_ID" ? t("payment.memo-metadata.label.id") : t("payment.memo-metadata.label.text"),
        placeholder: t("payment.memo-metadata.placeholder.mandatory")
      })
    } else {
      setMemoMetadata({
        label: t("payment.memo-metadata.label.default"),
        placeholder: t("payment.memo-metadata.placeholder.optional")
      })
    }
  }, [form, formValues.destination, formValues.memoType, matchingWellknownAccount, t, wellknownAccounts])

  const handleFormSubmission = () => {
    props.onSubmit(form.getValues(), spendableBalance, matchingWellknownAccount)
  }

  const handleQRScan = React.useCallback(
    (scanResult: string) => {
      const [destination, query] = scanResult.split("?")
      form.setValue("destination", destination)

      if (!query) {
        return
      }

      const searchParams = new URLSearchParams(query)
      const memoValue = searchParams.get("dt")

      if (memoValue) {
        form.setValue("memoType", "id")
        form.setValue("memoValue", memoValue)
      }
    },
    [form]
  )

  const qrReaderAdornment = React.useMemo(
    () => (
      <InputAdornment disableTypography position="end">
        <QRReader onScan={handleQRScan} />
      </InputAdornment>
    ),
    [handleQRScan]
  )

  const destinationInput = React.useMemo(
    () => (
      <TextField
        autoFocus={process.env.PLATFORM !== "ios"}
        error={Boolean(form.errors.destination)}
        fullWidth
        inputProps={{
          style: { textOverflow: "ellipsis" }
        }}
        InputProps={{
          endAdornment: qrReaderAdornment
        }}
        inputRef={form.register({
          required: t<string>("payment.validation.no-destination"),
          validate: value =>
            isPublicKey(value) || isStellarAddress(value) || t<string>("payment.validation.invalid-destination")
        })}
        label={form.errors.destination ? form.errors.destination.message : t("payment.inputs.destination.label")}
        margin="normal"
        name="destination"
        onChange={event => form.setValue("destination", event.target.value.trim())}
        placeholder={t("payment.inputs.destination.placeholder")}
      />
    ),
    [form, qrReaderAdornment, t]
  )

  const assetSelector = React.useMemo(
    () => (
      <Controller
        as={AssetSelector}
        assets={props.accountData.balances}
        control={form.control}
        disableUnderline
        name="asset"
        style={{ alignSelf: "center" }}
        testnet={props.testnet}
        value={formValues.asset}
      />
    ),
    [form, formValues.asset, props.accountData.balances, props.testnet]
  )

  const priceInput = React.useMemo(
    () => (
      <PriceInput
        assetCode={assetSelector}
        error={Boolean(form.errors.amount)}
        inputRef={form.register({
          required: t<string>("payment.validation.no-price"),
          pattern: { value: /^[0-9]+(\.[0-9]+)?$/, message: t<string>("payment.validation.invalid-price") },
          validate: value => BigNumber(value).lt(spendableBalance) || t<string>("payment.validation.not-enough-funds")
        })}
        label={form.errors.amount ? form.errors.amount.message : "Amount"}
        margin="normal"
        name="amount"
        placeholder={t("payment.inputs.price.placeholder", `Max. ${formatBalance(spendableBalance.toString())}`, {
          amount: formatBalance(spendableBalance.toString())
        })}
        style={{
          flexGrow: isSmallScreen ? 1 : undefined,
          marginLeft: 24,
          marginRight: 24,
          minWidth: 230,
          maxWidth: isSmallScreen ? undefined : "60%"
        }}
      />
    ),
    [assetSelector, form, isSmallScreen, spendableBalance, t]
  )

  const memoInput = React.useMemo(
    () => (
      <TextField
        error={Boolean(form.errors.memoValue)}
        inputProps={{ maxLength: 28 }}
        label={form.errors.memoValue ? form.errors.memoValue.message : memoMetadata.label}
        margin="normal"
        name="memoValue"
        inputRef={form.register({
          validate: {
            length: value => value.length <= 28 || "Memo too long.",
            memoRequired: value =>
              !matchingWellknownAccount ||
              matchingWellknownAccount.tags.indexOf("exchange") === -1 ||
              value.length > 0 ||
              t<string>(
                "payment.validation.memo-required",
                `Set a memo when sending funds to ${matchingWellknownAccount.name}`,
                {
                  destination: matchingWellknownAccount.name
                }
              ),
            idPattern: value =>
              formValues.memoType !== "id" ||
              value.match(/^[0-9]+$/) ||
              t<string>("payment.validation.integer-memo-required")
          }
        })}
        onChange={event => {
          const { value } = event.target
          const memoType = value.length === 0 ? "none" : formValues.memoType === "none" ? "text" : formValues.memoType
          form.setValue("memoValue", value)
          form.setValue("memoType", memoType)
        }}
        placeholder={memoMetadata.placeholder}
        style={{
          flexGrow: 1,
          marginLeft: 24,
          marginRight: 24,
          minWidth: 230
        }}
      />
    ),
    [form, formValues.memoType, matchingWellknownAccount, memoMetadata.label, memoMetadata.placeholder, t]
  )

  const dialogActions = React.useMemo(
    () => (
      <DialogActionsBox desktopStyle={{ marginTop: 64 }}>
        <ActionButton
          form={formID}
          icon={<SendIcon style={{ fontSize: 16 }} />}
          loading={props.txCreationPending}
          onClick={() => undefined}
          type="submit"
        >
          {t("payment.actions.submit")}
        </ActionButton>
      </DialogActionsBox>
    ),
    [formID, props.txCreationPending, t]
  )

  return (
    <form id={formID} noValidate onSubmit={form.handleSubmit(handleFormSubmission)}>
      {destinationInput}
      <HorizontalLayout justifyContent="space-between" alignItems="center" margin="0 -24px" wrap="wrap">
        {priceInput}
        {memoInput}
      </HorizontalLayout>
      <Portal target={props.actionsRef.element}>{dialogActions}</Portal>
    </form>
  )
})

interface Props {
  accountData: AccountData
  actionsRef: RefStateObject
  testnet: boolean
  trustedAssets: Asset[]
  txCreationPending?: boolean
  onCancel: () => void
  onSubmit: (createTx: (horizon: Server, account: Account) => Promise<Transaction>) => any
}

function PaymentFormContainer(props: Props) {
  const { lookupFederationRecord } = useFederationLookup()

  const createPaymentTx = async (horizon: Server, account: Account, formValues: PaymentFormValues) => {
    const asset = props.trustedAssets.find(trustedAsset => trustedAsset.equals(formValues.asset))
    const federationRecord =
      formValues.destination.indexOf("*") > -1 ? await lookupFederationRecord(formValues.destination) : null
    const destination = federationRecord ? federationRecord.account_id : formValues.destination

    const userMemo = createMemo(formValues)
    const federationMemo =
      federationRecord && federationRecord.memo && federationRecord.memo_type
        ? new Memo(federationRecord.memo_type as MemoType, federationRecord.memo)
        : Memo.none()

    if (userMemo.type !== "none" && federationMemo.type !== "none") {
      throw CustomError(
        "MemoAlreadySpecifiedError",
        `Cannot set a custom memo. Federation record of ${formValues.destination} already specifies memo.`,
        { destination: formValues.destination }
      )
    }

    const isMultisigTx = props.accountData.signers.length > 1

    const payment = await createPaymentOperation({
      asset: asset || Asset.native(),
      amount: formValues.amount,
      destination,
      horizon
    })
    const tx = await createTransaction([payment], {
      accountData: props.accountData,
      memo: federationMemo.type !== "none" ? federationMemo : userMemo,
      minTransactionFee: isMultisigTx ? multisigMinimumFee : 0,
      horizon,
      walletAccount: account
    })
    return tx
  }

  const submitForm = (formValues: PaymentFormValues) => {
    props.onSubmit((horizon, account) => createPaymentTx(horizon, account, formValues))
  }

  return <PaymentForm {...props} onSubmit={submitForm} />
}

export default React.memo(PaymentFormContainer)
