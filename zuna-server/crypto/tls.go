package crypto

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"time"
	"zuna-server/config"

	"github.com/rs/zerolog/log"
)

var ServerTLSCertificate []byte
var ServerTLSKey []byte

func LoadServerTLSCertificate() error {
	certData, errCert := os.ReadFile(config.Config.TLS.CertFile)
	keyData, errKey := os.ReadFile(config.Config.TLS.KeyFile)
	if os.IsNotExist(errCert) || os.IsNotExist(errKey) {
		if !config.Config.TLS.AutoGenerate {
			log.Error().Msg("TLS certificate or key file not found and auto generation is disabled")
			return os.ErrNotExist
		}

		log.Info().Msg("generating self-signed server TLS certificate")
		err := GenerateServerTLSCertificate()
		if err != nil {
			return err
		}

		return LoadServerTLSCertificate()
	}

	if errCert != nil {
		return errCert
	}

	if errKey != nil {
		return errKey
	}

	ServerTLSCertificate = certData
	ServerTLSKey = keyData

	return nil
}

func GenerateServerTLSCertificate() error {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		log.Error().Err(err).Msg("failed to generate server TLS private key")
		return err
	}

	serialNumberLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serialNumber, err := rand.Int(rand.Reader, serialNumberLimit)
	if err != nil {
		log.Error().Err(err).Msg("failed to generate TLS certificate serial number")
		return err
	}

	notBefore := time.Now().Add(-time.Hour)
	notAfter := notBefore.AddDate(10, 0, 0)

	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			CommonName: "zuna-server",
		},
		NotBefore: notBefore,
		NotAfter:  notAfter,
		KeyUsage:  x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{
			x509.ExtKeyUsageServerAuth,
		},
		DNSNames: []string{"localhost"},
		IPAddresses: []net.IP{
			net.ParseIP("127.0.0.1"),
			net.ParseIP("::1"),
			net.ParseIP(config.Config.TLS.PublicAddress),
		},
	}

	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		log.Error().Err(err).Msg("failed to generate self-signed TLS certificate")
		return err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "CERTIFICATE",
		Bytes: certDER,
	})

	if certPEM == nil {
		log.Error().Msg("failed to encode TLS certificate PEM")
		return os.ErrInvalid
	}

	keyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(priv),
	})
	if keyPEM == nil {
		log.Error().Msg("failed to encode TLS private key PEM")
		return os.ErrInvalid
	}

	err = os.WriteFile(config.Config.TLS.CertFile, certPEM, 0644)
	if err != nil {
		log.Error().Err(err).Msg("failed to save server TLS certificate")
		return err
	}

	err = os.WriteFile(config.Config.TLS.KeyFile, keyPEM, 0600)
	if err != nil {
		log.Error().Err(err).Msg("failed to save server TLS private key")
		return err
	}

	return nil
}
